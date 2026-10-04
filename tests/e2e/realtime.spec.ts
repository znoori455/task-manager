// Live collaboration over the WebSocket service: presence, cursors pinned to
// tasks, shared selection, typing and notifications.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { setupHeaders } from "./helpers";

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
