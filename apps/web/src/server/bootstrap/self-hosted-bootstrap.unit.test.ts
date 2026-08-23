import { describe, expect, it, vi } from "vitest";

import {
  cleanupBootstrapSession,
  DEFAULT_API_KEY_NAME,
  DEFAULT_TEAM_NAME,
  parseUseSendApiKey,
  provisionSelfHostedAccount,
  readBootstrapConfig,
} from "../../../scripts/bootstrap-self-hosted.mjs";

const API_KEY = "us_1234567890_0123456789abcdef0123456789abcdef";

function bootstrapConfig() {
  return {
    adminEmail: "vlad@bisceanu.com",
    adminName: "Vlad Bisceanu",
    teamName: DEFAULT_TEAM_NAME,
    apiKeyName: DEFAULT_API_KEY_NAME,
    apiKey: API_KEY,
    sessionToken: `usesend_bootstrap_${"a".repeat(64)}`,
    sessionHours: 2,
  };
}

function emptyTransaction() {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn(),
    },
    team: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 2, name: DEFAULT_TEAM_NAME }),
    },
    teamUser: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    apiKey: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 3,
          partialToken: data.partialToken,
        }),
      ),
      update: vi.fn(),
    },
    session: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
    },
  };
}

function prismaWithTransaction(
  transaction: ReturnType<typeof emptyTransaction>,
) {
  return {
    $transaction: vi.fn((callback) => callback(transaction)),
    session: transaction.session,
  };
}

describe("self-hosted bootstrap", () => {
  it("parses a useSend API key without returning its full value", () => {
    const parsed = parseUseSendApiKey(
      "us_1234567890_0123456789abcdef0123456789abcdef",
    );

    expect(parsed).toEqual({
      clientId: "1234567890",
      token: "0123456789abcdef0123456789abcdef",
      partialToken: "us_123...def",
    });
  });

  it.each([
    "",
    "us_short_0123456789abcdef0123456789abcdef",
    "us_ABCDEFGHIJ_0123456789abcdef0123456789abcdef",
    "us_1234567890_not-hex",
  ])("rejects an invalid API key: %s", (apiKey) => {
    expect(() => parseUseSendApiKey(apiKey)).toThrow(
      "SELF_HOSTED_BOOTSTRAP_API_KEY has an invalid format",
    );
  });

  it("normalizes the administrator email and supplies safe defaults", () => {
    const config = readBootstrapConfig({
      ADMIN_EMAIL: " Vlad@Bisceanu.com ",
      NEXT_PUBLIC_IS_CLOUD: "false",
      SELF_HOSTED_BOOTSTRAP_API_KEY:
        "us_1234567890_0123456789abcdef0123456789abcdef",
      SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN: `usesend_bootstrap_${"a".repeat(64)}`,
    });

    expect(config).toMatchObject({
      adminEmail: "vlad@bisceanu.com",
      teamName: DEFAULT_TEAM_NAME,
      apiKeyName: DEFAULT_API_KEY_NAME,
      sessionHours: 2,
    });
  });

  it.each(["a".repeat(64), `usesend_bootstrap_${"g".repeat(64)}`])(
    "rejects an unmarked or malformed bootstrap session: %s",
    (sessionToken) => {
      expect(() =>
        readBootstrapConfig({
          ADMIN_EMAIL: "vlad@bisceanu.com",
          NEXT_PUBLIC_IS_CLOUD: "false",
          SELF_HOSTED_BOOTSTRAP_API_KEY: API_KEY,
          SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN: sessionToken,
        }),
      ).toThrow("SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN must start with");
    },
  );

  it("refuses to run in cloud mode", () => {
    expect(() =>
      readBootstrapConfig({
        ADMIN_EMAIL: "vlad@bisceanu.com",
        NEXT_PUBLIC_IS_CLOUD: "true",
        SELF_HOSTED_BOOTSTRAP_API_KEY:
          "us_1234567890_0123456789abcdef0123456789abcdef",
        SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN: `usesend_bootstrap_${"a".repeat(64)}`,
      }),
    ).toThrow("Self-hosted bootstrap is disabled in cloud mode");
  });

  it("bounds the temporary session lifetime", () => {
    expect(() =>
      readBootstrapConfig({
        ADMIN_EMAIL: "vlad@bisceanu.com",
        NEXT_PUBLIC_IS_CLOUD: "false",
        SELF_HOSTED_BOOTSTRAP_API_KEY:
          "us_1234567890_0123456789abcdef0123456789abcdef",
        SELF_HOSTED_BOOTSTRAP_SESSION_TOKEN: `usesend_bootstrap_${"a".repeat(64)}`,
        SELF_HOSTED_BOOTSTRAP_SESSION_HOURS: "25",
      }),
    ).toThrow(
      "SELF_HOSTED_BOOTSTRAP_SESSION_HOURS must be an integer from 1 to 24",
    );
  });

  it("provisions an empty instance in one locked transaction", async () => {
    const transaction = emptyTransaction();
    const prisma = prismaWithTransaction(transaction);

    const result = await provisionSelfHostedAccount(prisma, bootstrapConfig());

    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock($1)",
      1431520590,
    );
    expect(transaction.user.create).toHaveBeenCalledWith({
      data: {
        email: "vlad@bisceanu.com",
        name: "Vlad Bisceanu",
        isBetaUser: true,
        isWaitlisted: false,
      },
    });
    expect(transaction.teamUser.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ role: "ADMIN" }),
        update: { role: "ADMIN" },
      }),
    );
    expect(transaction.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: "1234567890",
        name: DEFAULT_API_KEY_NAME,
        permission: "FULL",
        teamId: 2,
      }),
    });
    expect(transaction.session.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sessionToken: `usesend_bootstrap_${"a".repeat(64)}`,
          userId: 1,
        }),
      }),
    );
    expect(result).toMatchObject({
      userId: 1,
      teamId: 2,
      apiKeyId: 3,
      apiKeyPartial: "us_123...def",
    });
  });

  it("fails closed when another user already exists", async () => {
    const transaction = emptyTransaction();
    transaction.user.findMany.mockResolvedValue([
      { id: 9, email: "someone@example.com" },
    ]);
    const prisma = prismaWithTransaction(transaction);

    await expect(
      provisionSelfHostedAccount(prisma, bootstrapConfig()),
    ).rejects.toThrow(
      "Existing users conflict with the requested self-hosted administrator",
    );
    expect(transaction.team.create).not.toHaveBeenCalled();
  });

  it("rotates the named automation key without returning the secret", async () => {
    const transaction = emptyTransaction();
    transaction.user.findMany.mockResolvedValue([
      { id: 1, email: "vlad@bisceanu.com" },
    ]);
    transaction.user.update.mockResolvedValue({ id: 1 });
    transaction.team.findMany.mockResolvedValue([
      { id: 2, name: DEFAULT_TEAM_NAME },
    ]);
    transaction.apiKey.findMany.mockResolvedValue([
      {
        id: 3,
        clientId: "oldclient1",
        tokenHash: "old:hash",
        teamId: 2,
        partialToken: "us_old...old",
      },
    ]);
    transaction.apiKey.update.mockResolvedValue({
      id: 3,
      partialToken: "us_123...def",
    });
    const prisma = prismaWithTransaction(transaction);

    const result = await provisionSelfHostedAccount(prisma, bootstrapConfig());

    expect(transaction.apiKey.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: expect.objectContaining({
        clientId: "1234567890",
        partialToken: "us_123...def",
        permission: "FULL",
        domainId: null,
      }),
    });
    const update = transaction.apiKey.update.mock.calls[0]?.[0];
    expect(JSON.stringify(update)).not.toContain(API_KEY);
    expect(result).not.toHaveProperty("apiKey");
  });

  it("removes only the supplied temporary session", async () => {
    const transaction = emptyTransaction();
    transaction.session.deleteMany.mockResolvedValue({ count: 1 });
    const prisma = prismaWithTransaction(transaction);

    await expect(
      cleanupBootstrapSession(prisma, `usesend_bootstrap_${"a".repeat(64)}`),
    ).resolves.toEqual({ deletedSessions: 1 });
    expect(transaction.session.deleteMany).toHaveBeenCalledWith({
      where: { sessionToken: `usesend_bootstrap_${"a".repeat(64)}` },
    });
  });

  it("trims the temporary session token during cleanup", async () => {
    const transaction = emptyTransaction();
    transaction.session.deleteMany.mockResolvedValue({ count: 1 });
    const prisma = prismaWithTransaction(transaction);
    const sessionToken = `usesend_bootstrap_${"b".repeat(64)}`;

    await cleanupBootstrapSession(prisma, ` ${sessionToken}\n`);

    expect(transaction.session.deleteMany).toHaveBeenCalledWith({
      where: { sessionToken },
    });
  });
});
