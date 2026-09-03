import { errors, type Page } from "@playwright/test";

/**
 * Thin, named wrappers around the exact selectors confirmed by live
 * inspection of the built `@deepseek-ai/dsh-web-frontend` bundle (no
 * `data-testid`, no static `aria-label` string survives minification in the
 * bundle search — but the *rendered* DOM does carry stable `aria-label`s and
 * `role`s at runtime, confirmed by launching `dsh web` and reading the live
 * accessibility tree). Centralizing them here means a future DSH UI text
 * change only needs one file updated, not every assertion in the test.
 */

/** Dismisses the first-run "Internal Testing Notice" modal if it is showing. */
export async function dismissTestingNoticeIfPresent(page: Page): Promise<void> {
  const notice = page.getByRole("dialog", { name: "Internal Testing Notice", exact: true });
  const appeared = await notice
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof errors.TimeoutError) return false;
      throw error;
    });
  if (!appeared) return;

  await notice.getByRole("button", { name: "Continue", exact: true }).click();
  await notice.waitFor({ state: "hidden" });
}

/**
 * Opens the workspace picker, types an absolute directory path into the
 * dialog's editable breadcrumb (revealed by the "Edit path" button), and
 * confirms with Open. This is the only mechanism DSH's web UI exposes for
 * choosing an arbitrary filesystem workspace without pre-seeding profile
 * state, and it is what the model's task tool calls (cwd-relative Skill
 * discovery, MCP-launched Busabase) actually run against.
 */
export async function selectWorkspaceDirectory(page: Page, absolutePath: string): Promise<void> {
  await page.getByRole("button", { name: "Choose workspace", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Edit path" }).click();
  const pathInput = dialog.locator("input").first();
  await pathInput.fill(absolutePath);
  await pathInput.press("Enter");
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
}

/** The visible initial or follow-up prompt composer textarea. */
export function promptTextarea(page: Page) {
  return page.locator("textarea:visible").last();
}

/** Types the task prompt into the composer and submits it. */
export async function submitPrompt(page: Page, task: string): Promise<void> {
  const textarea = promptTextarea(page);
  await textarea.fill(task);
  await textarea.press("Enter");
}

/** Closes the Busabase details/fullscreen preview and waits for the DSH composer to return. */
export async function closeDetailsPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await promptTextarea(page).waitFor({ state: "visible" });
}

/** Performs the explicit human review flow and returns the automatically opened embed iframe URL. */
export async function approveMergeAndOpenPreview(page: Page, changeTitle: string): Promise<string> {
  const card = page
    .locator(".bb-card")
    .filter({ hasText: changeTitle })
    .filter({ hasText: "Review" });
  await card.last().locator(".bb-card-open").click();

  const panel = page.locator("aside.bb-panel");
  await panel.waitFor({ state: "visible" });
  await acceptConfirmation(page, () =>
    panel.getByRole("button", { name: "Approve", exact: true }).click(),
  );
  const merge = panel.getByRole("button", { name: "Merge", exact: true });
  await merge.waitFor({ state: "visible", timeout: 30_000 }).catch(async (error: unknown) => {
    throw new Error(`Inspector did not enter the approved state: ${await panel.innerText()}`, {
      cause: error,
    });
  });
  const embedResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname.startsWith("/embed/") &&
        url.searchParams.get("view") === "iframe" &&
        (response.status() < 300 || response.status() >= 400)
      );
    },
    { timeout: 60_000 },
  );
  await acceptConfirmation(page, () => merge.click());

  const frame = panel.locator("iframe.bb-embed-frame");
  await frame.waitFor({ state: "attached", timeout: 60_000 }).catch(async (error: unknown) => {
    throw new Error(`Inspector did not open the automatic embed: ${await panel.innerText()}`, {
      cause: error,
    });
  });
  const src = await frame.getAttribute("src");
  if (!src) throw new Error("automatic Busabase embed preview opened without an iframe URL");
  const response = await embedResponse;
  if (!response.ok()) {
    throw new Error(
      `automatic Busabase embed request failed (${String(response.status())}): ${src}`,
    );
  }
  const embedFrame = frame.contentFrame();
  const airAppFrame = embedFrame.getByTitle(changeTitle, { exact: true });
  await airAppFrame.waitFor({ state: "attached", timeout: 120_000 });
  await airAppFrame
    .contentFrame()
    .getByRole("heading", { name: changeTitle, exact: true })
    .waitFor({ state: "visible", timeout: 120_000 });
  return src;
}

async function acceptConfirmation(page: Page, action: () => Promise<void>): Promise<void> {
  page.once("dialog", (dialog) => void dialog.accept());
  await action();
}
