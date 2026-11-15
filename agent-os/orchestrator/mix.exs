defmodule Helix.Orchestrator.MixProject do
  use Mix.Project

  def project do
    [
      app: :helix_orchestrator,
      version: "0.1.0",
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: [],
      description: "HELIX orchestration: durable workflows, leases and A2A agent actors on OTP. No dependencies."
    ]
  end

  # inets/ssl for the gateway client, crypto for the log's hash chain; nothing from Hex.
  def application do
    [extra_applications: [:logger, :crypto, :inets, :ssl, :public_key]]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
end
