import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-browser/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

/** Keep Desktop out of plugin iframe/root fallbacks, even with an incomplete bridge. */
export function isDesktopHost(): boolean {
  return (globalThis as typeof globalThis & { dshDesktop?: unknown }).dshDesktop !== undefined;
}

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
          dshDesktop?: { protocolVersion?: number; browser?: unknown };
        }
      ).dshDesktop;
      if (carrier?.protocolVersion !== 1 || carrier.browser === undefined) return "unavailable";
      if (typeof ctx.get !== "function") return "unavailable";
      const sidebarRight = ctx.get("sidebarRight");
      const sidebarRightTabs = ctx.get("sidebarRightTabs");
      if (!sidebarRight || !sidebarRightTabs) return "unavailable";
      if (sidebarRightTabs.get("browser")?.id !== "@deepseek-ai/dsh-client-ui-sidebar-browser")
        return "unavailable";
      if (!input.sessionId) return "unavailable";
      if (sidebarRight.mounted.getSnapshot() !== input.sessionId) return "stale";
      if (!this.opened.has(key)) sidebarRight.openTab("browser", { params: { url: input.url } });
      else if (!sidebarRight.isExpanded()) sidebarRight.toggleExpanded();
      this.opened.add(key);
    } catch {
      // A later click/render can retry once the official services recover.
      return "error";
    }
    // Dispatch only, not proof of guest load. The host persists the full URL locally.
    return "opened";
  }

  /** Allows a deliberate reopen (e.g. after the user closes the native tab or clicks Reload). */
  forget(sessionId: string | null, spaceId: string | null, changeRequestId: string): void {
    this.opened.delete(this.key(sessionId, spaceId, changeRequestId));
  }

  private key(sessionId: string | null, spaceId: string | null, changeRequestId: string): string {
    return JSON.stringify([sessionId, spaceId, changeRequestId]);
  }
}
