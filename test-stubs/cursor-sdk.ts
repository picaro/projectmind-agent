/** Minimal stub so Vitest can resolve `@cursor/sdk` without mac-agent npm install. */
export class CursorAgentError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "CursorAgentError";
  }
}

export const Agent = {
  async create(): Promise<never> {
    throw new CursorAgentError("@cursor/sdk is stubbed in unit tests");
  },
};
