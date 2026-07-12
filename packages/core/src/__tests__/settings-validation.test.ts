import { describe, expect, it } from "vitest";
import {
  validateDirectMergeCommitStrategy,
  validateGithubAuthMode,
  validateGithubRepoSlug,
  validateHeartbeatPromptTemplate,
  validateHeartbeatScopeDisciplineMode,
  validateMcpServerDefinitionDetailed,
  validateUnavailableNodePolicy,
} from "../settings-validation.js";

describe("settings-validation", () => {
  describe("validateUnavailableNodePolicy", () => {
    it("accepts supported policies", () => {
      expect(validateUnavailableNodePolicy("block")).toBe("block");
      expect(validateUnavailableNodePolicy("fallback-local")).toBe("fallback-local");
    });

    it("returns undefined for invalid values", () => {
      expect(validateUnavailableNodePolicy("fallback")).toBeUndefined();
      expect(validateUnavailableNodePolicy(123)).toBeUndefined();
      expect(validateUnavailableNodePolicy(undefined)).toBeUndefined();
    });
  });

  describe("validateDirectMergeCommitStrategy", () => {
    it("accepts supported direct-merge routing values", () => {
      expect(validateDirectMergeCommitStrategy("auto")).toBe("auto");
      expect(validateDirectMergeCommitStrategy("always-squash")).toBe("always-squash");
      expect(validateDirectMergeCommitStrategy("always-rebase")).toBe("always-rebase");
    });

    it("returns undefined for invalid routing values", () => {
      expect(validateDirectMergeCommitStrategy("squash")).toBeUndefined();
      expect(validateDirectMergeCommitStrategy(123)).toBeUndefined();
      expect(validateDirectMergeCommitStrategy(undefined)).toBeUndefined();
    });
  });

  describe("validateGithubAuthMode", () => {
    it("accepts supported auth modes", () => {
      expect(validateGithubAuthMode("gh-cli")).toBe("gh-cli");
      expect(validateGithubAuthMode("token")).toBe("token");
    });

    it("returns undefined for invalid values", () => {
      expect(validateGithubAuthMode("oauth")).toBeUndefined();
      expect(validateGithubAuthMode(123)).toBeUndefined();
      expect(validateGithubAuthMode(undefined)).toBeUndefined();
    });
  });

  describe("validateHeartbeatScopeDisciplineMode", () => {
    it("accepts supported modes", () => {
      expect(validateHeartbeatScopeDisciplineMode("strict")).toBe("strict");
      expect(validateHeartbeatScopeDisciplineMode("lite")).toBe("lite");
      expect(validateHeartbeatScopeDisciplineMode("off")).toBe("off");
    });

    it("returns undefined for invalid values", () => {
      expect(validateHeartbeatScopeDisciplineMode("minimal")).toBeUndefined();
      expect(validateHeartbeatScopeDisciplineMode(123)).toBeUndefined();
      expect(validateHeartbeatScopeDisciplineMode(undefined)).toBeUndefined();
    });
  });

  describe("validateHeartbeatPromptTemplate", () => {
    it("accepts supported templates", () => {
      expect(validateHeartbeatPromptTemplate("default")).toBe("default");
      expect(validateHeartbeatPromptTemplate("compact")).toBe("compact");
    });

    it("returns undefined for invalid values", () => {
      expect(validateHeartbeatPromptTemplate("tiny")).toBeUndefined();
      expect(validateHeartbeatPromptTemplate(123)).toBeUndefined();
      expect(validateHeartbeatPromptTemplate(undefined)).toBeUndefined();
    });
  });

  describe("validateGithubRepoSlug", () => {
    it("accepts valid owner/repo slugs", () => {
      expect(validateGithubRepoSlug("owner/repo")).toBe("owner/repo");
      expect(validateGithubRepoSlug("Owner.Name/repo_name-1")).toBe("Owner.Name/repo_name-1");
    });

    it("treats empty strings as unset", () => {
      expect(validateGithubRepoSlug("")).toBeUndefined();
      expect(validateGithubRepoSlug("   ")).toBeUndefined();
    });

    it("returns undefined for malformed slugs and invalid types", () => {
      expect(validateGithubRepoSlug("owner")).toBeUndefined();
      expect(validateGithubRepoSlug("owner/repo/extra")).toBeUndefined();
      expect(validateGithubRepoSlug("owner repo/repo")).toBeUndefined();
      expect(validateGithubRepoSlug(42)).toBeUndefined();
      expect(validateGithubRepoSlug(undefined)).toBeUndefined();
    });
  });

  describe("validateMcpServerDefinitionDetailed — oauth auth variant (FUSI-073)", () => {
    it("still validates the no-auth headers-only path unchanged", () => {
      const result = validateMcpServerDefinitionDetailed({
        name: "docs",
        transport: "streamable-http",
        url: "https://docs.example.test/mcp",
        headers: { Authorization: { secretRef: "docs-token", scope: "project" } },
      });
      expect(result.errors).toEqual([]);
      expect(result.value).not.toHaveProperty("auth");
    });

    it("accepts oauth with a pre-registered clientId", () => {
      const result = validateMcpServerDefinitionDetailed({
        name: "asana",
        transport: "sse",
        url: "https://mcp.asana.test/sse",
        auth: {
          type: "oauth",
          authorizationServerUrl: "https://auth.asana.test",
          clientId: "fusion-client",
          clientSecret: { secretRef: "asana-client-secret", scope: "project" },
          scopes: ["projects:read"],
          redirectUrl: "https://dashboard.example.test/oauth/callback",
          accessToken: { secretRef: "asana-access-token", scope: "project" },
          refreshToken: { secretRef: "asana-refresh-token", scope: "project" },
          expiresAt: 1_800_000_000_000,
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.value?.transport === "sse" && result.value.auth).toEqual({
        type: "oauth",
        authorizationServerUrl: "https://auth.asana.test",
        clientId: "fusion-client",
        clientSecret: { secretRef: "asana-client-secret", scope: "project" },
        scopes: ["projects:read"],
        redirectUrl: "https://dashboard.example.test/oauth/callback",
        accessToken: { secretRef: "asana-access-token", scope: "project" },
        refreshToken: { secretRef: "asana-refresh-token", scope: "project" },
        expiresAt: 1_800_000_000_000,
      });
    });

    it("accepts oauth without a clientId (DCR-later)", () => {
      const result = validateMcpServerDefinitionDetailed({
        name: "linear",
        transport: "streamable-http",
        url: "https://mcp.linear.test/mcp",
        auth: { type: "oauth", authorizationServerUrl: "https://auth.linear.test" },
      });
      expect(result.errors).toEqual([]);
      expect(result.value).toMatchObject({ auth: { type: "oauth", authorizationServerUrl: "https://auth.linear.test" } });
    });

    it("accepts oauth pre-authorize state with no token bundle", () => {
      const result = validateMcpServerDefinitionDetailed({
        name: "notion",
        transport: "sse",
        url: "https://mcp.notion.test/sse",
        auth: {
          type: "oauth",
          authorizationServerUrl: "https://auth.notion.test",
          clientId: "pre-registered",
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.value).toMatchObject({
        auth: { type: "oauth", authorizationServerUrl: "https://auth.notion.test", clientId: "pre-registered" },
      });
    });

    it("rejects oauth missing authorizationServerUrl", () => {
      const result = validateMcpServerDefinitionDetailed({
        name: "bad",
        transport: "sse",
        url: "https://mcp.bad.test/sse",
        auth: { type: "oauth" },
      });
      expect(result.value).toBeUndefined();
      expect(result.errors.map((error) => error.code)).toContain("invalid-oauth-auth");
    });

    it("rejects inline plaintext accessToken and clientSecret", () => {
      const accessTokenResult = validateMcpServerDefinitionDetailed({
        name: "bad-token",
        transport: "sse",
        url: "https://mcp.bad.test/sse",
        auth: {
          type: "oauth",
          authorizationServerUrl: "https://auth.bad.test",
          accessToken: "plaintext-access-token",
        },
      });
      expect(accessTokenResult.value).toBeUndefined();
      expect(accessTokenResult.errors.map((error) => error.code)).toContain("plaintext-secret");

      const clientSecretResult = validateMcpServerDefinitionDetailed({
        name: "bad-secret",
        transport: "streamable-http",
        url: "https://mcp.bad.test/mcp",
        auth: {
          type: "oauth",
          authorizationServerUrl: "https://auth.bad.test",
          clientSecret: "plaintext-client-secret",
        },
      });
      expect(clientSecretResult.value).toBeUndefined();
      expect(clientSecretResult.errors.map((error) => error.code)).toContain("plaintext-secret");
    });

    it("rejects the wrong auth type", () => {
      const result = validateMcpServerDefinitionDetailed({
        name: "wrong-type",
        transport: "sse",
        url: "https://mcp.bad.test/sse",
        auth: { type: "basic", authorizationServerUrl: "https://auth.bad.test" },
      });
      expect(result.value).toBeUndefined();
      expect(result.errors.map((error) => error.code)).toContain("invalid-oauth-auth");
    });
  });
});
