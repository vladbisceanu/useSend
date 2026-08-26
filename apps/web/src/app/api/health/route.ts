import { db } from "~/server/db";
import { getRedis } from "~/server/redis";

export const dynamic = "force-dynamic";

const HEALTHCHECK_TIMEOUT_MS = 2_000;

async function waitForDependencies() {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.all([db.$queryRaw`SELECT 1`, getRedis().ping()]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Healthcheck timed out")),
          HEALTHCHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET() {
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown";

  try {
    await waitForDependencies();

    return Response.json(
      { data: "Healthy", commitSha },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { data: "Unhealthy", commitSha },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
