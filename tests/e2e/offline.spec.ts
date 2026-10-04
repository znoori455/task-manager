// Offline support: edits made offline are kept, survive a reload, and sync on
// reconnect; changes others made meanwhile are caught up via /changes.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { setupHeaders } from "./helpers";

async function userContext(browser: Browser, name: string, baseURL: string): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "tf_user", value: name, url: baseURL }]);
  return [context, await context.newPage()];
}

test("offline edits sync on reconnect, and missed remote changes are caught up", async ({ browser, baseURL, request }) => {
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-offline ${Date.now()}` }, headers })).json();
  const cmd = (id: string, command: object) => request.post(`/api/projects/${project.id}/commands`, { data: { clientMutationId: id, command }, headers });
  await cmd("seed-1", { type: "task.create", task: { id: `${project.id}-a`, title: "Write docs" } });
  await cmd("seed-2", { type: "task.create", task: { id: `${project.id}-b`, title: "Fix login bug" } });

  const [context, page] = await userContext(browser, "alice", baseURL!);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText("Live")).toBeVisible();
  await expect(page.getByTestId("task-row")).toHaveCount(2);
  await page.waitForTimeout(2000); // let the IndexedDB copy be written

  // Go offline and keep working.
  await context.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toContainText("You're offline");
  await page.getByPlaceholder("Add a task and press Enter").fill("Drafted on a plane");
  await page.keyboard.press("Enter");
  await page.getByTestId("task-row").filter({ hasText: "Write docs" }).click();
  await page.getByTestId("status-select").selectOption("in_progress");
  await expect(page.getByText("2 unsynced")).toBeVisible();

  // Meanwhile someone else changes another task.
  await cmd("remote-1", { type: "task.update", taskId: `${project.id}-b`, patch: { title: "Fix login bug (bob found the cause)" } });

  // Back online: queued edits are sent, and the missed remote change is caught up.
  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 task changed while you were away/)).toBeVisible();
  await expect(page.getByTestId("task-row").filter({ hasText: "bob found the cause" })).toBeVisible();
  await expect(page.getByText("Live")).toBeVisible();

  // The server has alice's offline edits.
  const { tasks } = await (await request.get(`/api/projects/${project.id}/tasks?limit=10`)).json();
  expect(tasks.map((t: { title: string }) => t.title)).toContain("Drafted on a plane");
  expect(tasks.find((t: { id: string }) => t.id === `${project.id}-a`).status).toBe("in_progress");
});

test("conflicting offline edits are rolled back on reconnect", async ({ browser, baseURL, request }) => {
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-conflict ${Date.now()}` }, headers })).json();
  const cmd = (id: string, command: object) => request.post(`/api/projects/${project.id}/commands`, { data: { clientMutationId: id, command }, headers });
  await cmd("seed-1", { type: "task.create", task: { id: `${project.id}-a`, title: "Doomed task" } });

  const [context, page] = await userContext(browser, "carol", baseURL!);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText("Live")).toBeVisible();

  await context.setOffline(true);
  await page.getByTestId("task-row").filter({ hasText: "Doomed task" }).click();
  await page.getByTestId("status-select").selectOption("in_progress");
  // While carol is offline, the task is deleted.
  await cmd("remote-del", { type: "task.delete", taskId: `${project.id}-a` });

  await context.setOffline(false);
  await expect(page.getByText(/Change rejected/)).toBeVisible();
  await expect(page.getByTestId("task-row")).toHaveCount(0);
});

test("a reload while offline opens the saved copy (production build only: needs the service worker)", async ({ browser, baseURL, request }) => {
  test.skip(!process.env.CI, "service worker is only registered in production builds");
  const headers = setupHeaders();
  const { project } = await (await request.post("/api/projects", { data: { name: `e2e-reload ${Date.now()}` }, headers })).json();
  await request.post(`/api/projects/${project.id}/commands`, {
    data: { clientMutationId: "seed", command: { type: "task.create", task: { id: `${project.id}-a`, title: "Cached task" } } },
    headers,
  });

  const [context, page] = await userContext(browser, "dave", baseURL!);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByTestId("task-row").filter({ hasText: "Cached task" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // let the service worker cache this page
  await expect(page.getByText("Live")).toBeVisible();
  await page.waitForTimeout(2000);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await expect(page.getByTestId("task-row").filter({ hasText: "Cached task" })).toBeVisible();
});
