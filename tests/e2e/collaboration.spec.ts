// Two users in two isolated browser contexts editing the same project.
import { expect, test, type Browser, type Page } from "@playwright/test";

async function userPage(browser: Browser, name: string, baseURL: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "tf_user", value: name, url: baseURL }]);
  return context.newPage();
}

test("changes sync between clients in real time", async ({ browser, baseURL, request }) => {
  const res = await request.post("/api/projects", { data: { name: `e2e ${Date.now()}` }, headers: { cookie: "tf_user=setup" } });
  const { project } = await res.json();

  const alice = await userPage(browser, "alice", baseURL!);
  const bob = await userPage(browser, "bob", baseURL!);
  await alice.goto(`/projects/${project.id}`);
  await bob.goto(`/projects/${project.id}`);
  await expect(alice.getByText("Live")).toBeVisible();
  await expect(bob.getByText("Live")).toBeVisible();

  // Alice creates a task -> Bob sees it.
  await alice.getByPlaceholder("Add a task and press Enter").fill("Ship the feature");
  await alice.keyboard.press("Enter");
  await expect(bob.getByTestId("task-row").filter({ hasText: "Ship the feature" })).toBeVisible();

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
  const headers = { cookie: "tf_user=setup" };
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
