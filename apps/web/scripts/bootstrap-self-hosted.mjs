import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SELF_HOSTED_REGISTRATION_LOCK_ID = 1431520590;
export const DEFAULT_API_KEY_NAME = "GrowthPath automation";
export const DEFAULT_TEAM_NAME = "GrowthPath Mail";
export const BOOTSTRAP_SESSION_PREFIX = "usesend_bootstrap_";
const BOOTSTRAP_SESSION_TOKEN_PATTERN =
  /^usesend_bootstrap_[0-9a-f]{64}$/;

export function isBootstrapSessionToken(sessionToken) {
  return BOOTSTRAP_SESSION_TOKEN_PATTERN.test(sessionToken);
}

export function parseUseSendApiKey(apiKey) {
  const match = /^us_([0-9a-z]{10})_([0-9a-f]{32})$/.exec(apiKey);
  if (!match) {
    throw new Error("SELF_HOSTED_BOOTSTRAP_API_KEY has an invalid format");
  }

  return {
    clientId: match[1],
    token: match[2],
    partialToken: `${apiKey.slice(0, 6)}...${apiKey.slice(-3)}`,
  };
}

export function readBootstrapConfig(environment) {
  if (environment.NEXT_PUBLIC_IS_CLOUD === "true") {
    throw new Error("Self-hosted bootstrap is disabled in cloud mode");
  }

  const adminEmail = environment.ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    throw new Error("ADMIN_EMAIL must be a valid email address");
  }

  const apiKey = environment.SELF_HOSTED_BOOTSTRAP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("SELF_HOSTED_BOOTSTRAP_API_KEY is required");
  }

  const sessionToken = environment.SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN?.trim();
  if (!sessionToken || !isBootstrapSessionToken(sessionToken)) {
    throw new Error(
      `SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN must start with ${BOOTSTRAP_SESSION_PREFIX} followed by 64 lowercase hex characters`,
    );
  }

  const sessionHours = Number(
    environment.SELF_HOSTED_BOOTSTRAP_SESSION_HOURS ?? "2",
  );
  if (
    !Number.isInteger(sessionHours) ||
    sessionHours < 1 ||
    sessionHours > 24
  ) {
    throw new Error(
      "SELF_HOSTED_BOOTSTRAP_SESSION_HOURS must be an integer from 1 to 24",
    );
  }

  return {
    adminEmail,
    adminName:
      environment.SELF_HOSTED_BOOTSTRAP_ADMIN_NAME?.trim() || undefined,
    teamName:
      environment.SELF_HOSTED_BOOTSTRAP_TEAM_NAME?.trim() || DEFAULT_TEAM_NAME,
    apiKeyName:
      environment.SELF_HOSTED_BOOTSTRAP_API_KEY_NAME?.trim() ||
      DEFAULT_API_KEY_NAME,
    apiKey,
    sessionToken,
    sessionHours,
  };
}

function createSecureHash(token) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(new TextEncoder().encode(token), salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

function verifySecureHash(token, hash) {
  const [salt, storedHash] = hash.split(":");
  if (!salt || !storedHash) {
    return false;
  }

  const derivedKey = scryptSync(
    new TextEncoder().encode(token),
    salt,
    64,
  ).toString("hex");
  return storedHash === derivedKey;
}

export async function provisionSelfHostedAccount(prisma, config) {
  const parsedApiKey = parseUseSendApiKey(config.apiKey);
  const expires = new Date(Date.now() + config.sessionHours * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock($1)",
      SELF_HOSTED_REGISTRATION_LOCK_ID,
    );

    const users = await tx.user.findMany({
      select: { id: true, email: true },
    });
    const conflictingUsers = users.filter(
      (user) => user.email?.trim().toLowerCase() !== config.adminEmail,
    );

    if (conflictingUsers.length > 0 || users.length > 1) {
      throw new Error(
        "Existing users conflict with the requested self-hosted administrator",
      );
    }

    const user =
      users.length === 1
        ? await tx.user.update({
            where: { id: users[0].id },
            data: {
              email: config.adminEmail,
              isBetaUser: true,
              isWaitlisted: false,
            },
          })
        : await tx.user.create({
            data: {
              email: config.adminEmail,
              name: config.adminName,
              isBetaUser: true,
              isWaitlisted: false,
            },
          });

    const teams = await tx.team.findMany({
      select: { id: true, name: true },
    });
    if (teams.length > 1) {
      throw new Error(
        "Multiple teams already exist in this self-hosted instance",
      );
    }
    if (teams.length === 1 && teams[0].name !== config.teamName) {
      throw new Error("The existing team conflicts with the requested team");
    }

    const team =
      teams[0] ??
      (await tx.team.create({
        data: {
          name: config.teamName,
          billingEmail: config.adminEmail,
        },
      }));

    const memberships = await tx.teamUser.findMany({
      where: { teamId: team.id },
      select: { userId: true, role: true },
    });
    if (memberships.some((membership) => membership.userId !== user.id)) {
      throw new Error("The existing team has an unexpected member");
    }

    await tx.teamUser.upsert({
      where: {
        teamId_userId: {
          teamId: team.id,
          userId: user.id,
        },
      },
      create: {
        teamId: team.id,
        userId: user.id,
        role: "ADMIN",
      },
      update: { role: "ADMIN" },
    });

    const apiKeyMatches = await tx.apiKey.findMany({
      where: {
        OR: [
          { clientId: parsedApiKey.clientId },
          { name: config.apiKeyName, teamId: team.id },
        ],
      },
    });
    if (
      apiKeyMatches.length > 1 ||
      apiKeyMatches.some((apiKey) => apiKey.teamId !== team.id)
    ) {
      throw new Error("Existing API keys conflict with the bootstrap key");
    }

    const existingApiKey = apiKeyMatches[0];
    const tokenHash =
      existingApiKey &&
      existingApiKey.clientId === parsedApiKey.clientId &&
      verifySecureHash(parsedApiKey.token, existingApiKey.tokenHash)
        ? existingApiKey.tokenHash
        : createSecureHash(parsedApiKey.token);

    const apiKey = existingApiKey
      ? await tx.apiKey.update({
          where: { id: existingApiKey.id },
          data: {
            clientId: parsedApiKey.clientId,
            tokenHash,
            partialToken: parsedApiKey.partialToken,
            name: config.apiKeyName,
            permission: "FULL",
            domainId: null,
          },
        })
      : await tx.apiKey.create({
          data: {
            clientId: parsedApiKey.clientId,
            tokenHash,
            partialToken: parsedApiKey.partialToken,
            name: config.apiKeyName,
            permission: "FULL",
            teamId: team.id,
          },
        });

    const existingSession = await tx.session.findUnique({
      where: { sessionToken: config.sessionToken },
    });
    if (existingSession && existingSession.userId !== user.id) {
      throw new Error("The bootstrap session belongs to another user");
    }

    await tx.session.upsert({
      where: { sessionToken: config.sessionToken },
      create: {
        sessionToken: config.sessionToken,
        userId: user.id,
        expires,
      },
      update: {
        userId: user.id,
        expires,
      },
    });

    return {
      userId: user.id,
      teamId: team.id,
      apiKeyId: apiKey.id,
      apiKeyPartial: apiKey.partialToken,
      sessionExpiresAt: expires.toISOString(),
    };
  });
}

export async function cleanupBootstrapSession(prisma, sessionToken) {
  const normalizedSessionToken = sessionToken?.trim();
  if (
    !normalizedSessionToken ||
    !isBootstrapSessionToken(normalizedSessionToken)
  ) {
    throw new Error(
      `SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN must start with ${BOOTSTRAP_SESSION_PREFIX} followed by 64 lowercase hex characters`,
    );
  }

  const result = await prisma.session.deleteMany({
    where: { sessionToken: normalizedSessionToken },
  });
  return { deletedSessions: result.count };
}

async function main() {
  const action = process.argv[2] ?? "provision";
  const prisma = new PrismaClient({ log: ["error"] });

  try {
    if (action === "cleanup-session") {
      const result = await cleanupBootstrapSession(
        prisma,
        process.env.SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN,
      );
      console.log(JSON.stringify({ action, ...result }));
      return;
    }

    if (action !== "provision") {
      throw new Error("Expected action: provision or cleanup-session");
    }

    const config = readBootstrapConfig(process.env);
    const result = await provisionSelfHostedAccount(prisma, config);
    console.log(JSON.stringify({ action, ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        action: process.argv[2] ?? "provision",
        error: error instanceof Error ? error.message : "Bootstrap failed",
      }),
    );
    process.exitCode = 1;
  });
}
