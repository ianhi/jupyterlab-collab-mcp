/**
 * Regression tests for the "cell tools say a demonstrably-open notebook is
 * not found" bug.
 *
 * Root cause: cell-indexed tools (get_notebook_content, execute_cell,
 * insert_cell, …) resolve a notebook through the real-time-collaboration
 * endpoint (PUT /api/collaboration/session/<path>), while kernel tools
 * (execute_code) resolve through /api/sessions + the kernel WebSocket. When
 * the server lacks the `jupyter-collaboration` extension that RTC route is
 * unregistered and returns 404 for *every* path — which the old code reported
 * as "Notebook '<path>' not found", even though the notebook exists and kernel
 * tools work on it.
 *
 * These tests pin the corrected behaviour:
 *  - an existing notebook on a non-RTC server yields an actionable
 *    "install jupyter-collaboration" error, NOT "not found";
 *  - a genuinely missing file still yields "not found";
 *  - the connect-time probe maps 405 -> available, 404 -> unavailable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setJupyterConfig,
  checkRtcAvailability,
  requestCollabSession,
  notebookFileExists,
  rtcAvailable,
  setRtcAvailable,
  type JupyterConfig,
} from "./connection.js";

const config: JupyterConfig = {
  host: "localhost",
  port: 8888,
  token: "tok",
  baseUrl: "http://localhost:8888",
  wsUrl: "ws://localhost:8888",
};

/** Minimal Response-like stub good enough for connection.ts call sites. */
function resp(status: number, body: unknown = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

/**
 * Route a stubbed fetch by URL substring. `ensureXsrf()` issues a GET to the
 * lab root before any state-changing request, so always answer that too.
 */
function stubServer(routes: { contentsStatus: number; collabSessionStatus: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("/api/contents/")) {
        return resp(routes.contentsStatus, { type: "notebook", path: "foo.ipynb" });
      }
      if (url.includes("/api/collaboration/session/")) {
        return resp(routes.collabSessionStatus);
      }
      // ensureXsrf root GET (and anything else): succeed with no cookie.
      return resp(200, "");
    })
  );
}

describe("RTC availability detection", () => {
  beforeEach(() => {
    setJupyterConfig(config);
    setRtcAvailable(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setJupyterConfig(null);
  });

  it("setJupyterConfig resets the cached RTC flag", () => {
    setRtcAvailable(true);
    setJupyterConfig(config);
    expect(rtcAvailable).toBe(null);
  });

  describe("checkRtcAvailability", () => {
    it("treats a 405 (route exists, PUT-only) as available", async () => {
      stubServer({ contentsStatus: 200, collabSessionStatus: 405 });
      expect(await checkRtcAvailability()).toBe(true);
      expect(rtcAvailable).toBe(true);
    });

    it("treats a 404 (route unregistered) as unavailable", async () => {
      stubServer({ contentsStatus: 200, collabSessionStatus: 404 });
      expect(await checkRtcAvailability()).toBe(false);
      expect(rtcAvailable).toBe(false);
    });

    it("leaves the verdict unknown (null) for inconclusive statuses (auth/proxy/5xx)", async () => {
      // A proxy login shell (200), an auth redirect, or a 5xx must NOT be
      // misread as a definitive available/unavailable verdict.
      for (const status of [200, 403, 502]) {
        setRtcAvailable(null);
        stubServer({ contentsStatus: 200, collabSessionStatus: status });
        expect(await checkRtcAvailability()).toBe(null);
        expect(rtcAvailable).toBe(null);
      }
    });
  });

  describe("notebookFileExists", () => {
    it("is true when the contents API finds the file", async () => {
      stubServer({ contentsStatus: 200, collabSessionStatus: 404 });
      expect(await notebookFileExists("foo.ipynb")).toBe(true);
    });

    it("is false when the contents API 404s", async () => {
      stubServer({ contentsStatus: 404, collabSessionStatus: 404 });
      expect(await notebookFileExists("nope.ipynb")).toBe(false);
    });
  });

  describe("requestCollabSession 404 disambiguation", () => {
    it("reports the actionable RTC error (NOT 'not found') for an existing notebook on a non-RTC server", async () => {
      // File exists (contents 200) but the collaboration route 404s.
      stubServer({ contentsStatus: 200, collabSessionStatus: 404 });
      await expect(requestCollabSession("foo.ipynb")).rejects.toThrow(
        /jupyter-collaboration/
      );
      // And crucially does NOT mislabel it as a missing notebook.
      await expect(requestCollabSession("foo.ipynb")).rejects.not.toThrow(
        /not found/i
      );
    });

    it("still reports 'not found' when the file genuinely does not exist", async () => {
      stubServer({ contentsStatus: 404, collabSessionStatus: 404 });
      await expect(requestCollabSession("ghost.ipynb")).rejects.toThrow(
        /not found/i
      );
    });

    it("fails fast with the RTC error when the connect-time probe already found RTC missing", async () => {
      setRtcAvailable(false);
      // No collab/contents request should be needed; assert the message anyway.
      stubServer({ contentsStatus: 200, collabSessionStatus: 404 });
      await expect(requestCollabSession("foo.ipynb")).rejects.toThrow(
        /jupyter-collaboration/
      );
    });
  });
});
