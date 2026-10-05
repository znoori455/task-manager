// Two users in two isolated browser contexts editing the same project.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { setupHeaders } from "./helpers";

/**
 * Answer the next dialog from a handler registered *before* the action that opens it.
 * (Awaiting the click first can deadlock: if the dialog opens before Playwright
 * finishes the click, the click waits for the dialog to be handled.) Resolves
 * with the dialog's message once it has been answered.
 */
function answerNextDialog(page: Page, accept: boolean): Promise<string> {
  return new Promise((resolve) =>
    page.once("dialog", async (d) => {
      const message = d.message();
      await (accept ? d.accept() : d.dismiss());
      resolve(message);
    }),
  );
}

async function userPage(browser: Browser, name: string, baseURL: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "tf_user", value: name, url: baseURL }]);
  return context.newPage();
}

test("changes sync between clients in real time", async ({ browser, baseURL, request }) => {
  const res = await request.post("/api/projects", { data: { name: `e2e ${Date.now()}` }, headers: setupHeaders() });
  const { project } = await res.json();

  const alice = await userPage(browser, "alice", baseURL!);
  const bob = await userPage(browser, "bob", baseURL!);
  await alice.goto(`/projects/${project.id}`);
  await bob.goto(`/projects/${project.id}`);
  await expect(alice.getByText("Live")).toBeVisible();
  await expect(bob.getByText("Live")).toBeVisible();

  // Alice creates a task -> it appears at the top of both lists, live.
  await alice.getByPlaceholder("Add a task and press Enter").fill("Ship the feature");
  await alice.keyboard.press("Enter");
  await expect(alice.getByTestId("task-row").first()).toContainText("Ship the feature");
  await expect(bob.getByTestId("task-row").first()).toContainText("Ship the feature");

  // Bob opens it and comments with a mention -> Alice sees the comment and gets notified.
  await bob.getByTestId("task-row").filter({ hasText: "Ship the feature" }).click();
  await bob.getByPlaceholder(/Write a comment/).fill("@alice on it");
  await bob.getByRole("button", { name: "Comment" }).click();
  await expect(alice.getByText(/bob mentioned you/)).toBeVisible();
  await expect(alice.getByTestId("task-row").filter({ hasText: "💬 1" })).toBeVisible();

  // Alice moves it to in progress -> Bob's panel updates.
  await alice.getByTestId("task-row").filter({ hasText: "Ship the feature" }).click();
  await alice.getByTestId("status-select").selectOption("in_progress");
  await expect(bob.getByTestId("status-select")).toHaveValue("in_progress");

  // Alice undoes -> both are back to "todo".
  await alice.getByRole("button", { name: /Undo/ }).click();
  await expect(bob.getByTestId("status-select")).toHaveValue("todo");
  await expect(alice.getByTestId("status-select")).toHaveValue("todo");
});

test("invalid transitions are rejected and rolled back", async ({ browser, baseURL, request }) => {
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-rules ${Date.now()}` }, headers })).json();
  const cmd = (clientMutationId: string, command: object) => request.post(`/api/projects/${project.id}/commands`, { data: { clientMutationId, command }, headers });
  await cmd("a", { type: "task.create", task: { id: `${project.id}-dep`, title: "Dependency" } });
  await cmd("b", { type: "task.create", task: { id: `${project.id}-main`, title: "Main task", status: "in_progress", dependencies: [`${project.id}-dep`] } });

  const page = await userPage(browser, "carol", baseURL!);
  await page.goto(`/projects/${project.id}`);
  await page.getByTestId("task-row").filter({ hasText: "Main task" }).click();
  await expect(page.getByText(/Blocked: finish 1 dependency/)).toBeVisible();
  await page.getByTestId("status-select").selectOption("in_review");
  await expect(page.getByText(/is blocked by: Dependency/)).toBeVisible();
  await expect(page.getByTestId("status-select")).toHaveValue("in_progress");
});

test("switching users from the account menu", async ({ browser, baseURL }) => {
  const page = await userPage(browser, "alice", baseURL!);
  await page.goto("/");
  await page.getByTestId("user-menu").click();
  await expect(page.getByText("Signed in as")).toBeVisible();
  await page.getByRole("button", { name: "Switch user" }).click();

  // Back to the name prompt; pick another name.
  await page.getByPlaceholder("e.g. alice").fill("bob");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("user-menu")).toContainText("bob");
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "tf_user")?.value).toBe("bob");
});

test("switching users with unsynced offline edits asks before discarding them", async ({ browser, baseURL, request }) => {
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-switch ${Date.now()}` }, headers })).json();
  const page = await userPage(browser, "carol", baseURL!);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText("Live")).toBeVisible();

  await page.context().setOffline(true);
  await page.getByPlaceholder("Add a task and press Enter").fill("Written offline by carol");
  await page.keyboard.press("Enter");
  await expect(page.getByText("1 unsynced")).toBeVisible();

  // Cancel: nothing changes, the edit is still queued.
  await page.getByTestId("user-menu").click();
  let answered = answerNextDialog(page, false);
  await page.getByRole("button", { name: "Switch user" }).click();
  expect(await answered).toContain("1 unsynced change");
  await expect(page.getByRole("button", { name: "Switch user" })).toBeHidden();
  await expect(page.getByText("1 unsynced")).toBeVisible();

  // Confirm: the edit is discarded and carol is signed out.
  await page.getByTestId("user-menu").click();
  answered = answerNextDialog(page, true);
  await page.getByRole("button", { name: "Switch user" }).click();
  await answered;
  // Offline, the session cookie is cleared in the browser.
  await expect.poll(async () => (await page.context().cookies()).some((c) => c.name === "tf_user")).toBe(false);
  await page.context().setOffline(false);
  await page.reload();
  await expect(page.getByPlaceholder("e.g. alice")).toBeVisible();
  await page.getByPlaceholder("e.g. alice").fill("dave");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Live")).toBeVisible();

  // The discarded task never reached the server under either name.
  await page.waitForTimeout(1000);
  const { tasks } = await (await request.get(`/api/projects/${project.id}/tasks`)).json();
  expect(tasks).toEqual([]);
});

test("lists re-sort live: a task someone else edits moves to the top without a refresh", async ({ browser, baseURL, request }) => {
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-order ${Date.now()}` }, headers })).json();
  const cmd = (id: string, command: object) => request.post(`/api/projects/${project.id}/commands`, { data: { clientMutationId: id, command }, headers });
  for (const n of [1, 2, 3]) await cmd(`c${n}`, { type: "task.create", task: { id: `${project.id}-${n}`, title: `Task ${n}` } });

  const page = await userPage(browser, `watcher${Date.now()}`, baseURL!);
  await page.goto(`/projects/${project.id}`);
  const rows = page.getByTestId("task-row");
  await expect(rows.first()).toContainText("Task 3"); // most recently updated first

  // Someone else edits the oldest task: it jumps to the top on its own.
  await cmd("edit", { type: "task.update", taskId: `${project.id}-1`, patch: { priority: "urgent" } });
  await expect(rows.first()).toContainText("Task 1");

  // ...and a task someone else creates appears at the top, too.
  await cmd("new", { type: "task.create", task: { id: `${project.id}-4`, title: "Task 4" } });
  await expect(rows.first()).toContainText("Task 4");
  await expect(rows).toHaveCount(4);
});

