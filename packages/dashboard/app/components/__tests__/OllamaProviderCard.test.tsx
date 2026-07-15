import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OllamaProviderCard } from "../OllamaProviderCard";

const api = vi.hoisted(() => ({ fetchOllamaStatus: vi.fn(), connectOllama: vi.fn(), refreshOllamaModels: vi.fn(), updateOllamaConfig: vi.fn(), updateOllamaEndpointAuth: vi.fn() }));
vi.mock("../../api", () => api);
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => <span /> }));
const status = { ready: false, endpointAuthConfigured: false, ollama: { enabled: false, endpoint: "http://localhost:11434", think: false, numCtx: 32768, executorEnabled: false, models: [] } };

describe("OllamaProviderCard", () => {
  afterEach(() => vi.clearAllMocks());
  it("renders empty native state and default-off executor opt-in", async () => {
    api.fetchOllamaStatus.mockResolvedValue(status);
    render(<OllamaProviderCard />);
    await screen.findByText("No discovered models");
    expect(screen.getByLabelText("Enable Ollama executor use")).not.toBeChecked();
    expect(screen.getByTestId("ollama-provider-card")).toHaveClass("ollama-provider-card");
    expect(screen.getByText(/local endpoints need no API key/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Optional Ollama endpoint token")).not.toBeInTheDocument();
  });
  it("connects then refreshes the picker callback and shows discovered capabilities", async () => {
    const onChanged = vi.fn();
    api.fetchOllamaStatus.mockResolvedValue(status);
    const connected = { ...status, ready: true, ollama: { ...status.ollama, enabled: true, models: [{ id: "qwen", name: "qwen", capabilities: ["tools"], toolCallingVerified: true }] } };
    api.connectOllama.mockResolvedValue(connected);
    render(<OllamaProviderCard onChanged={onChanged} />);
    await screen.findByText("No discovered models");
    fireEvent.click(screen.getByTestId("ollama-connect"));
    await screen.findByText(/qwen \(tools verified\)/);
    expect(api.connectOllama).toHaveBeenCalledWith({ endpoint: "http://localhost:11434" });
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("saves an explicitly optional protected-endpoint token without retaining or rendering its value", async () => {
    const configured = { ...status, endpointAuthConfigured: true };
    api.fetchOllamaStatus.mockResolvedValue(status);
    api.updateOllamaEndpointAuth.mockResolvedValue(configured);
    render(<OllamaProviderCard />);
    await screen.findByText("No discovered models");

    fireEvent.click(screen.getByRole("button", { name: "Add endpoint token" }));
    fireEvent.change(screen.getByLabelText("Optional Ollama endpoint token"), { target: { value: "protected-token" } });
    fireEvent.click(screen.getByTestId("ollama-save-endpoint-auth"));

    await waitFor(() => expect(api.updateOllamaEndpointAuth).toHaveBeenCalledWith("protected-token"));
    expect(screen.getByTestId("ollama-endpoint-auth-configured")).toHaveTextContent("Configured");
    expect(screen.queryByLabelText("Optional Ollama endpoint token")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("protected-token")).not.toBeInTheDocument();
  });

  it("clears only an already-configured protected-endpoint token", async () => {
    api.fetchOllamaStatus.mockResolvedValue({ ...status, endpointAuthConfigured: true });
    api.updateOllamaEndpointAuth.mockResolvedValue(status);
    render(<OllamaProviderCard />);
    await screen.findByTestId("ollama-endpoint-auth-configured");

    fireEvent.click(screen.getByRole("button", { name: "Clear endpoint token" }));
    await waitFor(() => expect(api.updateOllamaEndpointAuth).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId("ollama-endpoint-auth-configured")).not.toBeInTheDocument();
  });

  it("shows request errors without removing controls", async () => {
    api.fetchOllamaStatus.mockResolvedValue(status); api.refreshOllamaModels.mockRejectedValue(new Error("unreachable"));
    render(<OllamaProviderCard />); await screen.findByText("No discovered models"); fireEvent.click(screen.getByTestId("ollama-refresh"));
    await waitFor(() => expect(screen.getByTestId("ollama-error")).toHaveTextContent("unreachable"));
    expect(screen.getByLabelText("Ollama endpoint")).toBeInTheDocument();
  });
});
