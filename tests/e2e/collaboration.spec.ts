// Two users in two isolated browser contexts editing the same project.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { setupHeaders } from "./helpers";

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

  // Alice creates a task -> it's at the top of her list; Bob's list order is frozen,
  // so it shows up behind the "updated" pill.
  await alice.getByPlaceholder("Add a task and press Enter").fill("Ship the feature");
  await alice.keyboard.press("Enter");
  await expect(alice.getByTestId("task-row").first()).toContainText("Ship the feature");
  await bob.getByTestId("updates-pill").filter({ hasText: "1 updated" }).click();
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
  page.once("dialog", (d) => {
    expect(d.message()).toContain("1 unsynced change");
    void d.dismiss();
  });
  await page.getByTestId("user-menu").click();
  await page.getByRole("button", { name: "Switch user" }).click();
  await expect(page.getByText("1 unsynced")).toBeVisible();

  // Confirm: the edit is discarded and carol is signed out (cleared locally while offline).
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("user-menu").click();
  await page.getByRole("button", { name: "Switch user" }).click();
  await page.context().setOffline(false);
  await expect(page.getByPlaceholder("e.g. alice")).toBeVisible();
  await page.getByPlaceholder("e.g. alice").fill("dave");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Live")).toBeVisible();

  // The discarded task never reached the server under either name.
  await page.waitForTimeout(1000);
  const { tasks } = await (await request.get(`/api/projects/${project.id}/tasks`)).json();
  expect(tasks).toEqual([]);
});
