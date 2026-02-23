import { useEffect, useRef, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import Header from "@/components/Header";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, ArrowLeft, Music, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import MidiPlayer from "@/components/MidiPlayer";
import { useAuth } from "@/_core/hooks/useAuth";
import { getVoiceColors } from "@/lib/voiceColors";

const VOICE_OPTIONS = [
  { value: "soprano", label: "Soprano" },
  { value: "alto", label: "Alto" },
  { value: "tenor", label: "Tenor" },
  { value: "bass", label: "Bass" },
  { value: "other", label: "Other" },
];

export default function SheetDetail() {
  const { isLoading: authLoading } = useAuth({ redirectOnUnauthenticated: true });
  const [, params] = useRoute("/sheet/:id");
  const [, setLocation] = useLocation();
  const sheetId = params?.id || "";
  const utils = trpc.useUtils();

  const [voiceAssignments, setVoiceAssignments] = useState<Record<string, string>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [midiUrls, setMidiUrls] = useState<Record<string, string>>({});

  const { data: sheet, isLoading, refetch, status: queryStatus } = trpc.sheetMusic.get.useQuery(
    { id: sheetId },
    {
      enabled: !!sheetId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        // Poll every 3 s while processing. On a transient network error React
        // Query keeps the stale data, so status stays "processing" and polling
        // continues automatically. Setting retry:false means each poll attempt
        // fails fast and the next interval fires on schedule instead of waiting
        // for 2 extra back-off retries.
        return status === "processing" ? 3000 : false;
      },
      retry: false,   // let refetchInterval drive retries while processing
      staleTime: 3000, // match poll interval — avoids redundant background fetches
      gcTime: 300000,
    }
  );

  // Stall detection: warn the user if the sheet has been "processing" for >5 min
  // without any DB update (updatedAt hasn't changed).
  const [isStalled, setIsStalled] = useState(false);
  useEffect(() => {
    if (sheet?.status !== "processing") {
      setIsStalled(false);
      return;
    }
    const check = () => {
      if (sheet.updatedAt) {
        setIsStalled(Date.now() - new Date(sheet.updatedAt).getTime() > 5 * 60 * 1000);
      }
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, [sheet?.status, sheet?.updatedAt]);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  const renameMutation = trpc.sheetMusic.rename.useMutation({
    onSuccess: () => {
      utils.sheetMusic.get.invalidate({ id: sheetId });
      setEditingTitle(false);
    },
    onError: (error) => {
      toast.error(`Failed to rename: ${error.message}`);
    },
  });

  const startEditingTitle = () => {
    setTitleDraft(sheet?.title ?? "");
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  };

  const commitTitleEdit = () => {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === sheet?.title) {
      setEditingTitle(false);
      return;
    }
    renameMutation.mutate({ id: sheetId, title: trimmed });
  };

  const retryMutation = trpc.sheetMusic.retry.useMutation({
    onSuccess: () => {
      toast.success("Retrying processing…");
      utils.sheetMusic.get.invalidate({ id: sheetId });
    },
    onError: (error) => {
      toast.error(`Retry failed: ${error.message}`);
    },
  });

  const updateVoicesMutation = trpc.sheetMusic.updateVoiceAssignments.useMutation({
    onSuccess: () => {
      toast.success("Voice assignments updated!");
      setHasChanges(false);
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to update: ${error.message}`);
    },
  });

  // Initialize voice assignments from sheet data
  useEffect(() => {
    if (sheet?.voiceAssignments) {
      setVoiceAssignments(sheet.voiceAssignments as Record<string, string>);
    }
  }, [sheet]);

  // Load MIDI URLs when sheet is ready, and refresh them every 4 minutes
  // (cloud storage pre-signed URLs expire after 5 min)
  useEffect(() => {
    let isCancelled = false;

    const loadMidiUrls = async () => {
      if (sheet?.status === "ready" && sheet.midiFileKeys && !isCancelled) {
        const keys = sheet.midiFileKeys as Record<string, string>;
        const urls: Record<string, string> = {};

        for (const [voice] of Object.entries(keys)) {
          if (isCancelled) break;

          try {
            const result = await utils.sheetMusic.getMidiUrl.fetch({
              id: sheetId,
              voice,
            });
            if (!isCancelled) {
              urls[voice] = result.url;
            }
          } catch (error) {
            if (!isCancelled) {
              console.error(`Failed to load MIDI URL for ${voice}:`, error);
            }
          }
        }

        if (!isCancelled) {
          setMidiUrls(urls);
        }
      }
    };

    let refreshInterval: ReturnType<typeof setInterval> | null = null;

    if (sheet?.status === "ready" && sheet.midiFileKeys) {
      loadMidiUrls();
      // Refresh URLs every 4 minutes to prevent expiry
      refreshInterval = setInterval(loadMidiUrls, 4 * 60 * 1000);
    }

    return () => {
      isCancelled = true;
      if (refreshInterval) clearInterval(refreshInterval);
    };
  }, [sheet?.status, sheet?.midiFileKeys, sheetId]);

  // Show loading state while checking authentication (must be after all hooks)
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  const handleVoiceChange = (partIndex: string, newVoice: string) => {
    setVoiceAssignments((prev) => ({
      ...prev,
      [partIndex]: newVoice,
    }));
    setHasChanges(true);
  };

  const handleSaveChanges = () => {
    updateVoicesMutation.mutate({
      id: sheetId,
      voiceAssignments: voiceAssignments as Record<string, "soprano" | "alto" | "tenor" | "bass" | "other">,
    });
  };

  const handleResetToAutoDetected = () => {
    const parts = (sheet?.analysisResult as any)?.parts;
    if (!parts) return;
    const autoAssignments: Record<string, string> = {};
    for (const part of parts) {
      autoAssignments[part.index.toString()] = part.detected_voice;
    }
    setVoiceAssignments(autoAssignments);
    setHasChanges(true);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!sheet) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="p-8 text-center">
          <p className="text-lg mb-4">Sheet music not found</p>
          <Button onClick={() => setLocation("/")}>Go Back</Button>
        </Card>
      </div>
    );
  }

  const analysis = sheet.analysisResult as any;
  const availableVoices = Object.keys(midiUrls).filter(v => v !== "all");

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-6">
      <Header />
      <div className="container max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => setLocation("/")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div className="flex-1">
            {editingTitle ? (
              <Input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitleEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitleEdit();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="text-2xl font-bold h-auto py-0 border-0 border-b-2 rounded-none focus-visible:ring-0 focus-visible:border-blue-500 bg-transparent"
              />
            ) : (
              <h1
                className="text-3xl font-bold text-gray-900 dark:text-white cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                onClick={startEditingTitle}
                title="Click to rename"
              >
                {sheet.title}
              </h1>
            )}
            <p className="text-gray-600 dark:text-gray-300">{sheet.originalFilename}</p>
          </div>
        </div>

        {/* Processing Status */}
        {sheet.status === "processing" && (
          <Card className={`p-6 border ${isStalled ? "bg-amber-50 border-amber-300" : "bg-blue-50 border-blue-200"}`} aria-live="polite" aria-atomic="true">
            <div className="flex items-start gap-3">
              {isStalled
                ? <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                : <Loader2 className="h-5 w-5 animate-spin text-blue-500 mt-0.5 shrink-0" />
              }
              <div className="space-y-1">
                <p className="font-medium">
                  {sheet.errorMessage ?? "Processing your sheet music…"}
                </p>
                {isStalled ? (
                  <p className="text-sm text-amber-700">
                    This is taking longer than usual. The Python service may have stalled — you can
                    {" "}<button className="underline font-medium" onClick={() => retryMutation.mutate({ id: sheetId })}>retry</button>
                    {" "}or wait a little longer.
                  </p>
                ) : (
                  <p className="text-sm text-gray-600">
                    This may take a few minutes. The page will update automatically.
                  </p>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Error Status */}
        {sheet.status === "error" && (
          <Card className="p-6 bg-red-50 border-red-200" aria-live="assertive" aria-atomic="true">
            <div className="space-y-4">
              <div>
                <p className="font-medium text-red-900">Processing failed</p>
                <p className="text-sm text-red-700">{sheet.errorMessage || "An unknown error occurred during processing."}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => retryMutation.mutate({ id: sheetId })}
                  disabled={retryMutation.isPending}
                >
                  {retryMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Retry
                </Button>
                <Button variant="outline" onClick={() => setLocation("/")}>
                  Go Back
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Voice Assignment */}
        {sheet.status === "ready" && analysis && (
          <>
            <Card className="p-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-xl font-semibold">Voice Assignments</h2>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetToAutoDetected}
                      disabled={updateVoicesMutation.isPending}
                    >
                      Reset to auto-detected
                    </Button>
                    {hasChanges && (
                      <Button
                        onClick={handleSaveChanges}
                        disabled={updateVoicesMutation.isPending}
                      >
                        {updateVoicesMutation.isPending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          "Save Changes"
                        )}
                      </Button>
                    )}
                  </div>
                </div>

                <p className="text-sm text-gray-600">
                  We automatically detected {analysis.total_parts} part(s). Adjust
                  the voice assignments if needed.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {analysis.parts.map((part: any) => {
                    const assignedVoice = voiceAssignments[part.index.toString()] ?? part.detected_voice;
                    const colors = getVoiceColors(assignedVoice);
                    return (
                    <div
                      key={part.index}
                      className={`p-4 border-2 rounded-lg space-y-3 ${colors.border}`}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-medium">{part.name}</p>
                          <p className="text-sm text-gray-600">
                            {part.note_count} notes • {part.clef} clef
                          </p>
                        </div>
                        <Music className="h-5 w-5 text-gray-400" />
                      </div>

                      <div className="space-y-2">
                        <Label>Assign to voice:</Label>
                        <Select
                          value={voiceAssignments[part.index.toString()] || part.detected_voice}
                          onValueChange={(value) =>
                            handleVoiceChange(part.index.toString(), value)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {VOICE_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="text-xs text-gray-500">
                        Auto-detected: <span className={`px-1 rounded ${colors.badge}`}>{part.detected_voice}</span>
                      </div>
                    </div>
                  );
                  })}
                </div>
              </div>
            </Card>

            {/* MIDI Player */}
            {Object.keys(midiUrls).length > 0 && (
              <div>
                <h2 className="text-xl font-semibold mb-4">MIDI Player</h2>
                <MidiPlayer
                  midiUrls={midiUrls}
                  availableVoices={availableVoices}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

