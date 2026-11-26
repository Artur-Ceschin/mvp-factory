// The contract between the core and the generated app (src/app).
// CORE FILE — generated apps must not edit anything under src/core.

export interface SmokeCheck {
  /** Human-readable name shown in the factory report. */
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** "user" runs the check with a freshly signed-up test user's token. */
  auth?: "public" | "user";
  body?: unknown;
  expectStatus: number;
  /** Optional substring the response body must contain. */
  expectBodyIncludes?: string;
}

export interface AppManifest {
  /** Server-side event (tracked with track()) that means a user got real value, e.g. "workout_completed". */
  activationEvent: string;
  /** Checks the factory runs against every deployed stage. Keep them fast and side-effect-light. */
  smoke: SmokeCheck[];
  /**
   * Requests the design review sends as a freshly signed-up user (in memory, before taking the
   * logged-in screenshots) so the main screen shows realistic, specific data instead of an empty state.
   */
  demo?: DemoRequest[];
}

export interface DemoRequest {
  method: "POST" | "PUT" | "PATCH";
  path: string;
  body?: unknown;
}
