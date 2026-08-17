import { describe, test, expect, vi } from "vitest";
import { createLogger } from "./logger";

const SERVICE_PREFIX = "[opencode-models-discovery]";

describe("createLogger console fallback", () => {
  test("info logs via console.info with the service prefix", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createLogger().info("hello");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(`${SERVICE_PREFIX} hello`);
    } finally {
      spy.mockRestore();
    }
  });

  test("error routes to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createLogger().error("boom");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(`${SERVICE_PREFIX} boom`);
    } finally {
      spy.mockRestore();
    }
  });

  test("warn routes to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createLogger().warn("careful");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("debug routes to console.debug", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      createLogger().debug("trace");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("passes extra object as the second console argument", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createLogger().info("with extra", { a: 1 });
      expect(spy.mock.calls[0][0]).toBe(`${SERVICE_PREFIX} with extra`);
      expect(spy.mock.calls[0][1]).toEqual({ a: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  test("omits the extra argument when no extra is provided", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createLogger().info("bare");
      expect(spy.mock.calls[0]).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createLogger base extra merging", () => {
  test("includes base extra in every log call", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createLogger(undefined, { service: "x" }).info("msg");
      expect(spy.mock.calls[0][1]).toEqual({ service: "x" });
    } finally {
      spy.mockRestore();
    }
  });

  test("call-site extra overrides base extra keys", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createLogger(undefined, { k: "base" }).info("msg", { k: "override" });
      expect(spy.mock.calls[0][1]).toEqual({ k: "override" });
    } finally {
      spy.mockRestore();
    }
  });

  test("child logger merges parent base extra with child extra", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createLogger(undefined, { parent: 1 }).child({ child: 2 }).info("msg");
      expect(spy.mock.calls[0][1]).toEqual({ parent: 1, child: 2 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createLogger structured client path", () => {
  test("uses client.app.log when available and does not fall back to console", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logCalls: unknown[] = [];
    const client = {
      app: {
        log: (payload: unknown) => {
          logCalls.push(payload);
          return Promise.resolve();
        },
      },
    } as never;
    try {
      createLogger(client).info("structured", { x: 1 });
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toEqual({
        body: {
          service: "opencode-models-discovery",
          level: "info",
          message: "structured",
          extra: { x: 1 },
        },
      });
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });

  test("falls back to console when client.app.log throws synchronously", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = {
      app: {
        log: () => {
          throw new Error("nope");
        },
      },
    } as never;
    try {
      createLogger(client).info("resilient");
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toBe(`${SERVICE_PREFIX} resilient`);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
