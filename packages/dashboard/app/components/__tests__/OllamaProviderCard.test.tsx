import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OllamaProviderCard } from "../OllamaProviderCard";

const api = vi.hoisted(() => ({ fetchOllamaStatus: vi.fn(), connectOllama: vi.fn(), refreshOllamaModels: vi.fn(), updateOllamaConfig: vi.fn(), updateOllamaEndpointAuth: vi.fn() }));
vi.mock("../../api", () => api);
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => <span data-testid="ollama-icon" /> }));

const unavailableStatus = {
  ready: false,
  endpointAuthConfigured: false,
  availability: { available: false, reason: "Could not reach the Ollama endpoint" },
  ollama: { enabled: false, endpoint: "http://localhost:11434", think: false, numCtx: 32768, executorEnabled: false, models: [] },
};
const detectedStatus = {
  ...unavailableStatus,
  availability: { available: true, reason: "Ollama endpoint is reachable" },
};

describe("OllamaProviderCard", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders disabled unavailable native Ollama as a compact card without an enable checkbox", async () => {
    api.fetchOllamaStatus.mockResolvedValue(unavailableStatus);
    render(<OllamaProviderCard />);

    await screen.findByText("No discovered models");
    expect(screen.getByTestId("ollama-provider-card")).toHaveClass("auth-provider-card", "auth-provider-card--cli");
    expect(screen.getByTestId("ollama-provider-card-body")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("http://localhost:11434 — Could not reach the Ollama endpoint");
    expect(screen.getByTestId("ollama-enable")).toBeDisabled();
    expect(screen.queryByLabelText("Enable Ollama")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Enable Ollama executor use")).not.toBeChecked();
    expect(screen.queryByLabelText("Optional Ollama endpoint token")).not.toBeInTheDocument();
  });

  it("enables only after a detected endpoint successfully connects and reports the transition", async () => {
    const onChanged = vi.fn();
    api.fetchOllamaStatus.mockResolvedValue(detectedStatus);
    const enabled = {
      ...detectedStatus,
      ready: true,
      ollama: { ...detectedStatus.ollama, enabled: true, models: [{ id: "qwen", name: "qwen", capabilities: ["tools"], toolCallingVerified: true }] },
    };
    api.connectOllama.mockResolvedValue(enabled);
    render(<OllamaProviderCard onChanged={onChanged} />);

    await screen.findByText(/Detected\. Click Enable/);
    fireEvent.click(screen.getByTestId("ollama-enable"));

    await screen.findByText(/qwen \(tools verified\)/);
    expect(api.connectOllama).toHaveBeenCalledWith({ endpoint: "http://localhost:11434", enabled: true });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByTestId("ollama-disable")).toBeInTheDocument();
    expect(screen.getByText("✓ Active")).toBeInTheDocument();
  });

  it("tests a changed endpoint without falsely enabling a disabled provider", async () => {
    api.fetchOllamaStatus.mockResolvedValue(detectedStatus);
    const tested = {
      ...detectedStatus,
      ollama: { ...detectedStatus.ollama, endpoint: "https://proxy.example.test" },
    };
    api.connectOllama.mockResolvedValue(tested);
    render(<OllamaProviderCard />);
    await screen.findByText(/Detected\. Click Enable/);

    fireEvent.change(screen.getByLabelText("Ollama endpoint"), { target: { value: "https://proxy.example.test" } });
    fireEvent.click(screen.getByTestId("ollama-connect"));

    await waitFor(() => expect(api.connectOllama).toHaveBeenCalledWith({ endpoint: "https://proxy.example.test" }));
    expect(screen.getByTestId("ollama-enable")).toBeEnabled();
    expect(screen.queryByTestId("ollama-disable")).not.toBeInTheDocument();
  });

  it("disables an enabled native card and preserves endpoint/token controls", async () => {
    const enabled = { ...detectedStatus, ready: true, endpointAuthConfigured: true, ollama: { ...detectedStatus.ollama, enabled: true } };
    const disabled = { ...detectedStatus, endpointAuthConfigured: true };
    api.fetchOllamaStatus.mockResolvedValue(enabled);
    api.updateOllamaConfig.mockResolvedValue(disabled);
    render(<OllamaProviderCard />);
    await screen.findByTestId("ollama-disable");

    fireEvent.click(screen.getByTestId("ollama-disable"));
    await waitFor(() => expect(api.updateOllamaConfig).toHaveBeenCalledWith({ enabled: false }));
    expect(screen.getByTestId("ollama-enable")).toBeEnabled();
    expect(screen.getByTestId("ollama-endpoint-auth-configured")).toHaveTextContent("Configured");
  });

  it("saves an explicitly optional protected-endpoint token without retaining or rendering its value", async () => {
    const configured = { ...detectedStatus, endpointAuthConfigured: true };
    api.fetchOllamaStatus.mockResolvedValue(detectedStatus);
    api.updateOllamaEndpointAuth.mockResolvedValue(configured);
    render(<OllamaProviderCard />);
    await screen.findByText("No discovered models");

    fireEvent.click(screen.getByRole("button", { name: "Add endpoint token" }));
    fireEvent.change(screen.getByLabelText("Optional Ollama endpoint token"), { target: { value: "protected-token" } });
    fireEvent.click(screen.getByTestId("ollama-save-endpoint-auth"));

    await waitFor(() => expect(api.updateOllamaEndpointAuth).toHaveBeenCalledWith("protected-token", "http://localhost:11434"));
    expect(screen.getByTestId("ollama-endpoint-auth-configured")).toHaveTextContent("Configured");
    expect(screen.queryByLabelText("Optional Ollama endpoint token")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("protected-token")).not.toBeInTheDocument();
  });

  it("binds a new endpoint token to the edited endpoint before testing it", async () => {
    api.fetchOllamaStatus.mockResolvedValue(detectedStatus);
    api.updateOllamaEndpointAuth.mockResolvedValue({ ...detectedStatus, ollama: { ...detectedStatus.ollama, endpoint: "https://protected.example.test" }, endpointAuthConfigured: true });
    render(<OllamaProviderCard />);
    await screen.findByText("No discovered models");

    fireEvent.change(screen.getByLabelText("Ollama endpoint"), { target: { value: "https://protected.example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint token" }));
    fireEvent.change(screen.getByLabelText("Optional Ollama endpoint token"), { target: { value: "protected-token" } });
    fireEvent.click(screen.getByTestId("ollama-save-endpoint-auth"));

    await waitFor(() => expect(api.updateOllamaEndpointAuth).toHaveBeenCalledWith("protected-token", "https://protected.example.test"));
  });

  it("clears only an already-configured protected-endpoint token", async () => {
    api.fetchOllamaStatus.mockResolvedValue({ ...detectedStatus, endpointAuthConfigured: true });
    api.updateOllamaEndpointAuth.mockResolvedValue(detectedStatus);
    render(<OllamaProviderCard />);
    await screen.findByTestId("ollama-endpoint-auth-configured");

    fireEvent.click(screen.getByRole("button", { name: "Clear endpoint token" }));
    await waitFor(() => expect(api.updateOllamaEndpointAuth).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId("ollama-endpoint-auth-configured")).not.toBeInTheDocument();
  });

  it("shows request errors without removing compact mobile-safe controls", async () => {
    api.fetchOllamaStatus.mockResolvedValue(detectedStatus);
    api.refreshOllamaModels.mockRejectedValue(new Error("unreachable"));
    render(<OllamaProviderCard />);
    await screen.findByText("No discovered models");
    fireEvent.click(screen.getByTestId("ollama-refresh"));

    await waitFor(() => expect(screen.getByTestId("ollama-error")).toHaveTextContent("unreachable"));
    expect(screen.getByLabelText("Ollama endpoint")).toBeInTheDocument();
    expect(screen.getByTestId("ollama-provider-card")).toHaveClass("auth-provider-card--cli");
    expect(screen.getByTestId("ollama-provider-card-body")).toBeInTheDocument();
  });
});
