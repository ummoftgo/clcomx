import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import TerminalLoadingOverlay from "./TerminalLoadingOverlay.svelte";

describe("TerminalLoadingOverlay", () => {
  it("renders the main loading overlay with progress bar", () => {
    const { container } = render(TerminalLoadingOverlay, {
      label: "Connecting",
      hint: "Preparing terminal",
    });

    expect(screen.getByText("CLCOMX")).toBeInTheDocument();
    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getByText("Preparing terminal")).toBeInTheDocument();
    expect(container.querySelector(".terminal-connect-bar")).toBeInTheDocument();
    expect(container.querySelector(".terminal-connect-card--compact")).toBeNull();
  });

  it("renders the aux variant as compact subpanel without progress bar", () => {
    const { container } = render(TerminalLoadingOverlay, {
      variant: "aux",
      label: "Aux loading",
      hint: "Waiting for shell",
    });

    expect(screen.getByText("Aux loading")).toBeInTheDocument();
    expect(screen.getByText("Waiting for shell")).toBeInTheDocument();
    expect(container.querySelector(".terminal-connect-overlay--subpanel")).toBeInTheDocument();
    expect(container.querySelector(".terminal-connect-overlay--aux-panel")).toBeInTheDocument();
    expect(container.querySelector(".terminal-connect-card--compact")).toBeInTheDocument();
    expect(container.querySelector(".terminal-connect-bar")).toBeNull();
  });

  it("allows custom eyebrow copy", () => {
    render(TerminalLoadingOverlay, {
      label: "Connecting",
      hint: "Preparing terminal",
      eyebrow: "Terminal",
    });

    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.queryByText("CLCOMX")).not.toBeInTheDocument();
  });
});
