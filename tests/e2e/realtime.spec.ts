// Live collaboration over the WebSocket service: presence, cursors pinned to
// tasks, shared selection, typing and notifications.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { setupHeaders } from "./helpers";

/** The editor's text, without other people's caret labels (which render inline in the DOM). */
function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector("[data-testid=collab-description] .cm-content");
    if (!content) return "";
    const copy = content.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".cm-ySelectionCaret, .cm-ySelectionInfo, .cm-widgetBuffer").forEach((n) => n.remove());
    return copy.innerText.replace(/\u2060/g, "").trim();
  });
}

async function userPage(browser: Browser, name: string, baseURL: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "tf_user", value: name, url: baseURL }]);
  return context.newPage();
}

test("presence, cursors, selection, typing and notifications are shared live", async ({ browser, baseURL, request }) => {
  const stamp = Date.now();
  const [alice, bob] = [`alice${stamp}`, `bob${stamp}`];
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-realtime ${stamp}` }, headers })).json();
  await request.post(`/api/projects/${project.id}/commands`, {
    data: { clientMutationId: "seed", command: { type: "task.create", task: { id: `${project.id}-a`, title: "Plan the launch", assignedTo: [alice] } } },
    headers,
  });

  const a = await userPage(browser, alice, baseURL!);
  const b = await userPage(browser, bob, baseURL!);
  await a.goto(`/projects/${project.id}`);
  await b.goto(`/projects/${project.id}`);

  // Presence: both avatars in the header.
  await expect(a.getByTestId("presence").getByTitle(bob)).toBeVisible();

  // Cursor pinned to the task: bob hovers the row, alice sees his pointer on that row.
  const bobRow = b.getByTestId("task-row").filter({ hasText: "Plan the launch" });
  const box = (await bobRow.boundingBox())!;
  await b.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await b.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 5 });
  const aliceRow = a.getByTestId("task-row").filter({ hasText: "Plan the launch" });
  await expect(aliceRow.getByTestId("remote-cursor")).toContainText(bob);

  // Pointer leaves the tasks: the cursor disappears.
  await b.mouse.move(5, 5);
  await expect(aliceRow.getByTestId("remote-cursor")).toHaveCount(0);

  // Shared selection: bob opens the task and edits the title; alice sees it.
  await bobRow.click();
  await expect(aliceRow.getByTitle(bob)).toBeVisible();
  await aliceRow.click();
  await b.getByTestId("task-panel").getByRole("textbox").first().focus();
  await expect(a.getByTestId("editing-title")).toHaveText(`${bob} is editing…`);

  // Typing indicator, then a mention -> alice is notified (bell + toast).
  await b.getByPlaceholder(/Write a comment/).fill(`@${alice} can you review?`);
  await expect(a.getByTestId("typing-indicator")).toHaveText(`${bob} is typing…`);
  await b.getByRole("button", { name: "Comment" }).click();
  await expect(a.getByText(new RegExp(`${bob} mentioned you in “Plan the launch”`))).toBeVisible();
  await expect(a.getByTestId("unread-count")).toHaveText("2"); // the mention + being assigned the task at setup
  await a.getByTestId("notification-bell").click();
  await expect(a.getByTestId("notification-list")).toContainText("can you review?");

  // Leaving is instant.
  await b.close();
  await expect(a.getByTestId("presence").getByTitle(bob)).toHaveCount(0);
});

test("notifications can be marked read, dismissed and cleared, and other tabs follow", async ({ browser, baseURL, request }) => {
  const stamp = Date.now();
  const me = `erin${stamp}`;
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-notify ${stamp}` }, headers })).json();
  const cmd = (id: string, command: object) => request.post(`/api/projects/${project.id}/commands`, { data: { clientMutationId: id, command }, headers });
  await cmd("t", { type: "task.create", task: { id: `${project.id}-a`, title: "Review" } });
  for (const i of [1, 2, 3]) await cmd(`c${i}`, { type: "comment.add", comment: { id: `${project.id}-c${i}`, taskId: `${project.id}-a`, content: `@${me} note ${i}` } });

  // Two tabs of the same user.
  const context = await browser.newContext();
  await context.addCookies([{ name: "tf_user", value: me, url: baseURL! }]);
  const [tab1, tab2] = [await context.newPage(), await context.newPage()];
  await Promise.all([tab1.goto("/"), tab2.goto("/")]);
  for (const tab of [tab1, tab2]) await expect(tab.getByTestId("unread-count")).toHaveText("3");
  // Wait until tab2's live connection is up, so it receives the sync messages.
  await expect.poll(() => tab2.evaluate(() => document.querySelectorAll("[data-testid=project-list]").length)).toBe(1);
  await tab2.waitForTimeout(500);

  // Mark all read: badge disappears in both tabs, the items stay.
  await tab1.getByTestId("notification-bell").click();
  await tab1.getByRole("button", { name: "Mark all read" }).click();
  for (const tab of [tab1, tab2]) await expect(tab.getByTestId("unread-count")).toHaveCount(0);
  await expect(tab1.getByTestId("notification")).toHaveCount(3);

  // Dismiss one.
  const first = tab1.getByTestId("notification").filter({ hasText: "note 3" });
  await first.hover();
  await first.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(tab1.getByTestId("notification")).toHaveCount(2);
  await tab2.getByTestId("notification-bell").click();
  await expect(tab2.getByTestId("notification")).toHaveCount(2);

  // Clear all, in both tabs, and on the server.
  await tab1.getByRole("button", { name: "Clear all" }).click();
  await expect(tab1.getByText("No notifications.")).toBeVisible();
  await expect(tab2.getByText("No notifications.")).toBeVisible();
  const res = await request.get("/api/notifications", { headers: { cookie: `tf_user=${me}` } });
  expect((await res.json()).notifications).toEqual([]);
});


test("two people edit a description together: text merges live, carets show, and it's saved", async ({ browser, baseURL, request }) => {
  const stamp = Date.now();
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-collab ${stamp}` }, headers })).json();
  const taskId = `${project.id}-doc`;
  await request.post(`/api/projects/${project.id}/commands`, {
    data: { clientMutationId: "seed", command: { type: "task.create", task: { id: taskId, title: "Write the spec", configuration: { description: "Goals." } } } },
    headers,
  });

  const open = async (name: string) => {
    const page = await userPage(browser, name, baseURL!);
    await page.goto(`/projects/${project.id}?task=${taskId}`);
    const editor = page.getByTestId("collab-description").locator(".cm-content");
    await expect(editor).toHaveText("Goals.");
    return { page, editor };
  };
  const ann = await open(`ann${stamp}`);
  const ben = await open(`ben${stamp}`);

  // Ann appends; Ben prepends. Both edits merge in both editors.
  await ann.editor.click();
  await ann.page.keyboard.press("End");
  await ann.page.keyboard.type(" Non-goals.");
  await ben.editor.click();
  await ben.page.keyboard.press("Home");
  await ben.page.keyboard.type("Spec: ");
  const merged = "Spec: Goals. Non-goals.";
  for (const p of [ann.page, ben.page]) await expect.poll(() => editorText(p)).toBe(merged);

  // Each sees the other's caret, labelled with their name.
  await expect(ann.page.locator(".cm-ySelectionInfo")).toHaveText(`ben${stamp}`);
  await expect(ben.page.locator(".cm-ySelectionInfo")).toHaveText(`ann${stamp}`);

  // Autosaved through the normal pipeline: the server has the merged text, and a reload shows it.
  await expect
    .poll(async () => (await (await request.get(`/api/projects/${project.id}/tasks?ids=${taskId}`)).json()).tasks[0].configuration.description)
    .toBe(merged);
  await ann.page.reload();
  await expect.poll(() => editorText(ann.page)).toBe(merged);
});

const REALTIME_WS = `ws://localhost:${process.env.E2E_REALTIME_PORT ?? 3001}/ws`;

async function projectWithTask(request: import("@playwright/test").APIRequestContext, title: string, description = "") {
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e ${title} ${Date.now()}` }, headers })).json();
  const taskId = `${project.id}-t`;
  await request.post(`/api/projects/${project.id}/commands`, {
    data: { clientMutationId: "seed", command: { type: "task.create", task: { id: taskId, title, configuration: { description } } } },
    headers,
  });
  return { projectId: project.id as string, taskId, headers };
}

test("fast typing in a shared description arrives in full, without dropping the connection", async ({ browser, baseURL, request }) => {
  const stamp = Date.now();
  const { projectId, taskId } = await projectWithTask(request, "Burst");
  const open = async (name: string) => {
    const page = await userPage(browser, name, baseURL!);
    // Record WebSocket closes (the service closes floods with code 1008).
    await page.addInitScript(() => {
      (window as unknown as { __closes: number[] }).__closes = [];
      const Orig = window.WebSocket;
      window.WebSocket = class extends Orig {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          this.addEventListener("close", (e) => (window as unknown as { __closes: number[] }).__closes.push(e.code));
        }
      } as typeof WebSocket;
    });
    await page.goto(`/projects/${projectId}?task=${taskId}`);
    await expect(page.getByTestId("collab-description").locator(".cm-content")).toBeVisible();
    return page;
  };
  const typist = await open(`fast${stamp}`);
  const reader = await open(`reader${stamp}`);

  const burst = "lorem ipsum dolor sit amet ".repeat(15).trim(); // ~400 keystrokes, no delay
  await typist.getByTestId("collab-description").locator(".cm-content").click();
  await typist.keyboard.type(burst);

  await expect.poll(() => editorText(reader), { timeout: 5000 }).toBe(burst);
  expect(await typist.evaluate(() => (window as unknown as { __closes: number[] }).__closes)).not.toContain(1008);
});

test("a panel opened while the realtime service is unreachable upgrades to live editing once it's back", async ({ browser, baseURL, request }) => {
  const { projectId, taskId } = await projectWithTask(request, "Upgrade", "Start.");
  const page = await userPage(browser, `late${Date.now()}`, baseURL!);
  let blocked = true;
  await page.routeWebSocket(REALTIME_WS, (ws) => {
    if (blocked) ws.close();
    else ws.connectToServer();
  });
  await page.goto(`/projects/${projectId}?task=${taskId}`);
  const panel = page.getByTestId("task-panel");
  await expect(panel.getByPlaceholder("Add a description…")).toHaveValue("Start.");
  await expect(panel.getByText(/Co-editing is reconnecting/)).toBeVisible();

  blocked = false; // the client retries with backoff
  await expect(page.getByTestId("collab-description").locator(".cm-content")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => editorText(page)).toBe("Start.");
});

test("a focused field still shows other people's changes until you start typing", async ({ browser, baseURL, request }) => {
  const { projectId, taskId, headers } = await projectWithTask(request, "Original title");
  const page = await userPage(browser, `focus${Date.now()}`, baseURL!);
  await page.goto(`/projects/${projectId}?task=${taskId}`);
  const title = page.getByTestId("task-panel").getByRole("textbox").first();
  await expect(title).toHaveValue("Original title");
  await title.focus();

  await request.post(`/api/projects/${projectId}/commands`, {
    data: { clientMutationId: "rename", command: { type: "task.update", taskId, patch: { title: "Renamed by someone else" } } },
    headers,
  });
  await expect(title).toHaveValue("Renamed by someone else");
  await expect(title).toBeFocused();
});
