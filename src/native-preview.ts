import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-browser/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

export type NativePreviewResult = "opened" | "unavailable" | "stale" | "error";

interface OpenChangeRequestPreviewInput {
  readonly sessionId: string | null;
  readonly spaceId: string | null;
  readonly changeRequestId: string;
  readonly url: string;
}

/**
 * Deduplicates native opens per adapter instance: a session switching back and
 * forth, or a preview re-fetch after a live-refresh tick, must not stack
 * duplicate Browser tabs (sidebar-browser's `browser` kind declares `multiple: true`).
 */
export class NativeChangeRequestPreview {
  private readonly opened = new Set<string>();
  private readonly failed = new Set<string>();

  /**
   * Desktop-only dispatch through the official host browser. Web retains the
   * plugin sandbox. The host requires workspaces to install native bodies.
   * "opened" means dispatch, not guest load; full URLs persist locally in the host.
   */
  open(ctx: Context, input: OpenChangeRequestPreviewInput): NativePreviewResult {
    const key = this.key(input.sessionId, input.spaceId, input.changeRequestId);
    try {
      const carrier = (
        globalThis as typeof globalThis & {
          dshDesktop?: { protocolVersion?: number; browser?: { acquire?: unknown } };
        }
      ).dshDesktop;
      if (carrier?.protocolVersion !== 1 || typeof carrier.browser?.acquire !== "function")
        return "unavailable";
      if (typeof ctx.get !== "function" || !ctx.get("workspaces")) return "unavailable";
      const sidebarRight = ctx.get("sidebarRight");
      const sidebarRightTabs = ctx.get("sidebarRightTabs");
      if (!sidebarRight || !sidebarRightTabs) return "unavailable";
      if (sidebarRightTabs.get("browser")?.id !== "@deepseek-ai/dsh-client-ui-sidebar-browser")
        return "unavailable";
      if (!input.sessionId) return "unavailable";
      if (sidebarRight.mounted.getSnapshot() !== input.sessionId) return "stale";
      if (this.opened.has(key)) return "opened";
      if (this.failed.has(key)) return "error";
      sidebarRight.openTab("browser", { params: { url: input.url } });
      this.opened.add(key);
    } catch {
      // Host wiring mistake (e.g. a kind unregistered between the check above
      // and this call); never surface as a crash, fall back to the iframe.
      this.failed.add(key);
      return "error";
    }
    // Dispatch only, not proof of guest load. The host persists the full URL locally.
    return "opened";
  }

  /** Allows a deliberate reopen (e.g. after the user closes the native tab or clicks Reload). */
  forget(sessionId: string | null, spaceId: string | null, changeRequestId: string): void {
    this.opened.delete(this.key(sessionId, spaceId, changeRequestId));
    this.failed.delete(this.key(sessionId, spaceId, changeRequestId));
  }

  private key(sessionId: string | null, spaceId: string | null, changeRequestId: string): string {
    return JSON.stringify([sessionId, spaceId, changeRequestId]);
  }
}
