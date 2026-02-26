import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Header from "@/components/Header";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Eye, EyeOff, Save, Zap, ExternalLink, Loader2 } from "lucide-react";

export default function Settings() {
  const { isLoading: authLoading } = useAuth({ redirectOnUnauthenticated: true });

  const { data: config, isLoading: configLoading } = trpc.settings.getGeminiConfig.useQuery();
  const utils = trpc.useUtils();

  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelName, setModelName] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [hasEdited, setHasEdited] = useState(false);

  // Populate defaults from server config when loaded
  const initialized = useState(false);
  if (config && !initialized[0]) {
    setModelName(config.modelName);
    setMaxTokens(String(config.maxOutputTokens));
    initialized[1](true);
  }

  const updateMutation = trpc.settings.updateGeminiConfig.useMutation({
    onSuccess: () => {
      toast.success("Settings saved");
      setApiKey("");
      setHasEdited(false);
      utils.settings.getGeminiConfig.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const testMutation = trpc.settings.testGeminiConnection.useMutation({
    onSuccess: (data) => {
      toast.success(`Connection successful! Model: ${data.model || "OK"}`);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function handleSave() {
    const input: {
      apiKey?: string;
      modelName?: string;
      maxOutputTokens?: number;
    } = {};

    if (apiKey) input.apiKey = apiKey;
    if (modelName && modelName !== config?.modelName) input.modelName = modelName;

    const parsedTokens = parseInt(maxTokens, 10);
    if (!isNaN(parsedTokens) && parsedTokens !== config?.maxOutputTokens) {
      input.maxOutputTokens = parsedTokens;
    }

    if (Object.keys(input).length === 0) {
      toast.info("No changes to save");
      return;
    }

    updateMutation.mutate(input);
  }

  if (authLoading || configLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
        <Header />
        <div className="container mx-auto px-6 py-16 flex justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <Header />

      <div className="container mx-auto px-6 py-12 max-w-2xl">
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">
          Settings
        </h2>

        <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
          <h3 className="text-xl font-semibold mb-1 dark:text-white">
            Gemini AI Configuration
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            Configure the Google Gemini API used for PDF sheet music recognition (OMR).
          </p>

          <div className="space-y-5">
            {/* API Key Status */}
            <div className="flex items-center gap-2 text-sm">
              <div
                className={`w-2 h-2 rounded-full ${
                  config?.apiKeySet ? "bg-green-500" : "bg-red-500"
                }`}
              />
              <span className="text-gray-600 dark:text-gray-300">
                {config?.apiKeySet
                  ? `API key is set (source: ${config.apiKeySource})`
                  : "No API key configured"}
              </span>
            </div>

            {/* API Key */}
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showApiKey ? "text" : "password"}
                  placeholder={config?.apiKeySet ? "Enter new key to replace current" : "Enter your Gemini API key"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setHasEdited(true);
                  }}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  aria-label={showApiKey ? "Hide API key" : "Show API key"}
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Get a key from{" "}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline inline-flex items-center gap-0.5"
                >
                  Google AI Studio
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>

            {/* Model Name */}
            <div className="space-y-2">
              <Label htmlFor="modelName">Model Name</Label>
              <Input
                id="modelName"
                type="text"
                value={modelName}
                onChange={(e) => {
                  setModelName(e.target.value);
                  setHasEdited(true);
                }}
                placeholder="gemini-2.0-flash"
              />
              <p className="text-xs text-gray-400 dark:text-gray-500">
                The Gemini model to use for PDF recognition
              </p>
            </div>

            {/* Max Output Tokens */}
            <div className="space-y-2">
              <Label htmlFor="maxTokens">Max Output Tokens</Label>
              <Input
                id="maxTokens"
                type="number"
                value={maxTokens}
                onChange={(e) => {
                  setMaxTokens(e.target.value);
                  setHasEdited(true);
                }}
                min={1024}
                max={65536}
                placeholder="8192"
              />
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Maximum tokens for the model's response (1024 - 65536)
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <Button
                onClick={handleSave}
                disabled={updateMutation.isPending || (!hasEdited && !apiKey)}
              >
                {updateMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save Settings
              </Button>

              <Button
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-2" />
                )}
                Test Connection
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
