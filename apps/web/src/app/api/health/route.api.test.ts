import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ping: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("~/server/db", () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

vi.mock("~/server/redis", () => ({
  getRedis: () => ({ ping: mocks.ping }),
}));

import { GET } from "~/app/api/health/route";

describe("health route", () => {
  beforeEach(() => {
    mocks.ping.mockResolvedValue("PONG");
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "abc123");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("returns the deployed SHA when dependencies are ready", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ data: "Healthy", commitSha: "abc123" });
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.ping).toHaveBeenCalledOnce();
  });

  it("fails readiness when Postgres is unavailable", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      data: "Unhealthy",
      commitSha: "abc123",
    });
  });

  it("fails readiness when Redis is unavailable", async () => {
    mocks.ping.mockRejectedValue(new Error("redis unavailable"));

    const response = await GET();

    expect(response.status).toBe(503);
  });

  it("bounds dependency checks", async () => {
    vi.useFakeTimers();
    mocks.queryRaw.mockReturnValue(new Promise(() => undefined));

    const responsePromise = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
  });
});
