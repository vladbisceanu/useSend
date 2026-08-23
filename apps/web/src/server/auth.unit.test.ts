import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterUser } from "next-auth/adapters";

const mocks = vi.hoisted(() => {
  const env = {
    GITHUB_ID: "github-client-id",
    GITHUB_SECRET: "github-client-secret",
    NEXT_PUBLIC_IS_CLOUD: true,
  };

  const baseCreateUser = vi.fn();
  const baseGetUserByEmail = vi.fn();
  const baseUpdateSession = vi.fn();
  const accountFindUnique = vi.fn();
  const userFindUnique = vi.fn();
  const userFindFirst = vi.fn();
  const inviteFindFirst = vi.fn();
  const transactionUserFindFirst = vi.fn();
  const transactionInviteFindFirst = vi.fn();
  const transactionUserCreate = vi.fn();
  const executeRaw = vi.fn();
  const sessionFindUnique = vi.fn();
  const transaction = vi.fn(async (callback) =>
    callback({
      $executeRaw: executeRaw,
      user: {
        findFirst: transactionUserFindFirst,
        create: transactionUserCreate,
      },
      teamInvite: {
        findFirst: transactionInviteFindFirst,
      },
    }),
  );

  return {
    env,
    baseCreateUser,
    baseGetUserByEmail,
    baseUpdateSession,
    accountFindUnique,
    userFindUnique,
    userFindFirst,
    inviteFindFirst,
    transactionUserFindFirst,
    transactionInviteFindFirst,
    transactionUserCreate,
    executeRaw,
    sessionFindUnique,
    transaction,
  };
});

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: vi.fn(() => ({
    createUser: mocks.baseCreateUser,
    getUserByEmail: mocks.baseGetUserByEmail,
    updateSession: mocks.baseUpdateSession,
  })),
}));

vi.mock("next-auth/providers/github", () => ({
  default: vi.fn((options) => ({ id: "github", options })),
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((options) => ({ id: "google", options })),
}));

vi.mock("next-auth/providers/email", () => ({
  default: vi.fn((options) => ({ id: "email", options })),
}));

vi.mock("~/server/db", () => ({
  db: {
    account: {
      findUnique: mocks.accountFindUnique,
    },
    user: {
      findUnique: mocks.userFindUnique,
      findFirst: mocks.userFindFirst,
    },
    teamInvite: {
      findFirst: mocks.inviteFindFirst,
    },
    session: {
      findUnique: mocks.sessionFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("~/server/mailer", () => ({
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/env", () => ({ env: mocks.env }));

import {
  authOptions,
  canRegisterSelfHostedUser,
  SelfHostedRegistrationError,
} from "~/server/auth";

const newUser = {
  id: "new-user",
  name: "New User",
  email: "new@example.com",
  emailVerified: null,
  image: null,
  isBetaUser: false,
  isWaitlisted: false,
  isAdmin: false,
};

const newUserWithoutEmail = {
  ...newUser,
  email: null,
} as unknown as AdapterUser;

describe("authOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.NEXT_PUBLIC_IS_CLOUD = true;
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.inviteFindFirst.mockResolvedValue(null);
    mocks.transactionUserFindFirst.mockResolvedValue(null);
    mocks.transactionInviteFindFirst.mockResolvedValue(null);
    mocks.transactionUserCreate.mockResolvedValue({ ...newUser, id: 1 });
    mocks.sessionFindUnique.mockResolvedValue(null);
    mocks.baseGetUserByEmail.mockResolvedValue(null);
  });

  it("configures the GitHub provider with an explicit issuer", () => {
    const githubProvider = authOptions.providers.find(
      (provider) => provider.id === "github",
    );

    expect(githubProvider).toMatchObject({
      id: "github",
      options: {
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
        issuer: "https://github.com/login/oauth",
      },
    });
  });

  describe("self-hosted registration policy", () => {
    beforeEach(() => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
    });

    it("allows the first user without an invite", async () => {
      await expect(
        canRegisterSelfHostedUser("first@example.com"),
      ).resolves.toBe(true);

      expect(mocks.inviteFindFirst).not.toHaveBeenCalled();
    });

    it("allows an existing user to sign in without an invite", async () => {
      mocks.userFindUnique.mockResolvedValue({ id: 1 });

      await expect(
        canRegisterSelfHostedUser(" Existing@Example.com "),
      ).resolves.toBe(true);

      expect(mocks.userFindUnique).toHaveBeenCalledWith({
        where: { email: "existing@example.com" },
        select: { id: true },
      });
      expect(mocks.userFindFirst).not.toHaveBeenCalled();
      expect(mocks.inviteFindFirst).not.toHaveBeenCalled();
    });

    it("allows an existing OAuth account to sign in without an email", async () => {
      mocks.accountFindUnique.mockResolvedValue({ id: "account_1" });

      await expect(
        canRegisterSelfHostedUser(null, {
          provider: "github",
          providerAccountId: "github-user-id",
          type: "oauth",
        }),
      ).resolves.toBe(true);

      expect(mocks.accountFindUnique).toHaveBeenCalledWith({
        where: {
          provider_providerAccountId: {
            provider: "github",
            providerAccountId: "github-user-id",
          },
        },
        select: { id: true },
      });
      expect(mocks.userFindFirst).not.toHaveBeenCalled();
    });

    it("allows a new user with a matching invite", async () => {
      mocks.userFindFirst.mockResolvedValue({ id: 1 });
      mocks.inviteFindFirst.mockResolvedValue({ id: "invite_1" });

      await expect(
        canRegisterSelfHostedUser("invited@example.com"),
      ).resolves.toBe(true);

      expect(mocks.inviteFindFirst).toHaveBeenCalledWith({
        where: { email: "invited@example.com" },
        select: { id: true },
      });
    });

    it("rejects a new user without a matching invite", async () => {
      mocks.userFindFirst.mockResolvedValue({ id: 1 });

      await expect(
        canRegisterSelfHostedUser("random@example.com"),
      ).resolves.toBe(false);
    });

    it("allows the first account when the provider returns no email", async () => {
      await expect(canRegisterSelfHostedUser(null)).resolves.toBe(true);
      expect(mocks.userFindUnique).not.toHaveBeenCalled();
    });

    it("rejects a later account when the provider returns no email", async () => {
      mocks.userFindFirst.mockResolvedValue({ id: 1 });

      await expect(canRegisterSelfHostedUser(null)).resolves.toBe(false);
      expect(mocks.inviteFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("adapter user creation", () => {
    const createUser = authOptions.adapter?.createUser;

    if (!createUser) {
      throw new Error("Expected the auth adapter to support user creation");
    }

    it("keeps cloud user creation unchanged", async () => {
      mocks.baseCreateUser.mockResolvedValue({ ...newUser, id: 1 });

      await createUser({ ...newUser, email: " New@Example.com " });

      expect(mocks.baseCreateUser).toHaveBeenCalledWith({
        ...newUser,
        email: "new@example.com",
      });
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("atomically creates the first self-hosted user", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;

      await expect(createUser(newUser)).resolves.toMatchObject({
        id: 1,
        email: newUser.email,
      });

      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.executeRaw).toHaveBeenCalledOnce();
      expect(mocks.executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
        mocks.transactionUserFindFirst.mock.invocationCallOrder[0]!,
      );
      expect(mocks.transactionInviteFindFirst).not.toHaveBeenCalled();
      expect(mocks.transactionUserCreate).toHaveBeenCalledWith({
        data: {
          name: newUser.name,
          email: newUser.email,
          emailVerified: newUser.emailVerified,
          image: newUser.image,
        },
      });
    });

    it("atomically creates the first self-hosted user without an email", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserCreate.mockResolvedValueOnce({
        ...newUserWithoutEmail,
        id: 1,
      });

      await expect(createUser(newUserWithoutEmail)).resolves.toMatchObject({
        id: 1,
        email: null,
      });

      expect(mocks.transactionInviteFindFirst).not.toHaveBeenCalled();
      expect(mocks.transactionUserCreate).toHaveBeenCalledWith({
        data: {
          name: newUser.name,
          email: null,
          emailVerified: newUser.emailVerified,
          image: newUser.image,
        },
      });
    });

    it("atomically creates an invited self-hosted user", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });
      mocks.transactionInviteFindFirst.mockResolvedValue({ id: "invite_1" });

      await expect(createUser(newUser)).resolves.toMatchObject({
        id: 1,
        email: newUser.email,
      });

      expect(mocks.transactionInviteFindFirst).toHaveBeenCalledWith({
        where: { email: newUser.email },
        select: { id: true },
      });
      expect(mocks.transactionUserCreate).toHaveBeenCalledWith({
        data: {
          name: newUser.name,
          email: newUser.email,
          emailVerified: newUser.emailVerified,
          image: newUser.image,
        },
      });
    });

    it("does not create an uninvited self-hosted user", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });

      await expect(createUser(newUser)).rejects.toBeInstanceOf(
        SelfHostedRegistrationError,
      );

      expect(mocks.transactionUserCreate).not.toHaveBeenCalled();
    });

    it("does not create a later self-hosted user without an email", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });

      await expect(createUser(newUserWithoutEmail)).rejects.toBeInstanceOf(
        SelfHostedRegistrationError,
      );

      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.transactionUserCreate).not.toHaveBeenCalled();
    });
  });

  describe("adapter email lookup", () => {
    const getUserByEmail = authOptions.adapter?.getUserByEmail;

    if (!getUserByEmail) {
      throw new Error("Expected the auth adapter to support email lookup");
    }

    it("normalizes OAuth email casing before the first account link", async () => {
      await getUserByEmail(" Vlad@Bisceanu.com ");

      expect(mocks.baseGetUserByEmail).toHaveBeenCalledWith(
        "vlad@bisceanu.com",
      );
    });
  });

  describe("adapter session updates", () => {
    const updateSession = authOptions.adapter?.updateSession;

    if (!updateSession) {
      throw new Error("Expected the auth adapter to support session updates");
    }

    it("does not extend a marked bootstrap session", async () => {
      const originalExpires = new Date("2026-08-23T08:00:00.000Z");
      const requestedExpires = new Date("2026-09-22T06:00:00.000Z");
      const sessionToken = `usesend_bootstrap_${"a".repeat(64)}`;
      mocks.sessionFindUnique.mockResolvedValue({ expires: originalExpires });
      mocks.baseUpdateSession.mockResolvedValue({
        sessionToken,
        userId: 1,
        expires: originalExpires,
      });

      await updateSession({ sessionToken, expires: requestedExpires });

      expect(mocks.baseUpdateSession).toHaveBeenCalledWith({
        sessionToken,
        expires: originalExpires,
      });
    });

    it("allows a marked bootstrap session to expire earlier", async () => {
      const originalExpires = new Date("2026-08-23T08:00:00.000Z");
      const requestedExpires = new Date("2026-08-23T07:00:00.000Z");
      const sessionToken = `usesend_bootstrap_${"b".repeat(64)}`;
      mocks.sessionFindUnique.mockResolvedValue({ expires: originalExpires });

      await updateSession({ sessionToken, expires: requestedExpires });

      expect(mocks.baseUpdateSession).toHaveBeenCalledWith({
        sessionToken,
        expires: requestedExpires,
      });
    });

    it("keeps ordinary session refresh behavior unchanged", async () => {
      const requestedExpires = new Date("2026-09-22T06:00:00.000Z");

      await updateSession({
        sessionToken: "ordinary-session-token",
        expires: requestedExpires,
      });

      expect(mocks.baseUpdateSession).toHaveBeenCalledWith({
        sessionToken: "ordinary-session-token",
        expires: requestedExpires,
      });
      expect(mocks.sessionFindUnique).not.toHaveBeenCalled();
    });
  });
});
