import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
import { Loader2, ArrowLeft, Music, AlertTriangle, Pencil, Eye, CheckCircle2, BookOpen } from "lucide-react";
import { toast } from "sonner";
import MidiPlayer from "@/components/MidiPlayer";
import { useAuth } from "@/_core/hooks/useAuth";
import { getVoiceColors } from "@/lib/voiceColors";
import type { ConfidenceData } from "@/components/NotationEditor";
import { PlaybackSyncProvider } from "@/hooks/usePlaybackSync";

const NotationEditor = lazy(() => import("@/components/NotationEditor"));

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

  const [processingStep, setProcessingStep] = useState<string | null>(null);
  const [voiceAssignments, setVoiceAssignments] = useState<Record<string, string>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [midiUrls, setMidiUrls] = useState<Record<string, string>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [followScore, setFollowScore] = useState(false);
  const [musicxmlContent, setMusicxmlContent] = useState<string | null>(null);

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

  // SSE for real-time processing status updates
  useEffect(() => {
    if (sheet?.status !== "processing") {
      setProcessingStep(null);
      return;
    }

    const es = new EventSource(`/api/sse/sheet/${sheetId}`);

    es.addEventListener("processing_step", (e) => {
      try {
        const data = JSON.parse(e.data);
        setProcessingStep(data.step);
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("status_changed", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status === "ready" || data.status === "error") {
          refetch();
        }
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      es.close();
      // Falls back to existing 3s polling
    };

    return () => es.close();
  }, [sheet?.status, sheetId, refetch]);

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

  const updateMusicXMLMutation = trpc.sheetMusic.updateMusicXML.useMutation({
    onSuccess: () => {
      toast.success("Score updated — regenerating MIDI...");
      setIsEditing(false);
      setIsReviewing(false);
      setMusicxmlContent(null);
      utils.sheetMusic.get.invalidate({ id: sheetId });
    },
    onError: (err) => {
      toast.error(`Save failed: ${err.message}`);
    },
  });

  const openReviewMode = async () => {
    if (!sheet) return;
    if (!musicxmlContent && sheet.musicxmlKey) {
      try {
        const res = await fetch(`/files/${sheet.musicxmlKey}`);
        const xml = await res.text();
        setMusicxmlContent(xml);
      } catch {
        toast.error("Failed to load score for review");
        return;
      }
    }
    setIsReviewing(true);
  };

  const toggleFollowScore = async () => {
    if (!followScore && !musicxmlContent && sheet?.musicxmlKey) {
      try {
        const res = await fetch(`/files/${sheet.musicxmlKey}`);
        const xml = await res.text();
        setMusicxmlContent(xml);
      } catch {
        toast.error("Failed to load score");
        return;
      }
    }
    setFollowScore((prev) => !prev);
  };

  // Initialize voice assignments from sheet data.
  // F-05: guard on !hasChanges so the 3-second poll never overwrites edits the
  // user has made but not yet saved. After a successful save, hasChanges is
  // reset to false and the next refetch re-syncs from the server.
  useEffect(() => {
    if (sheet?.voiceAssignments && !hasChanges) {
      setVoiceAssignments(sheet.voiceAssignments as Record<string, string>);
    }
  }, [sheet, hasChanges]);

  // F-06: stringify midiFileKeys so the effect dep uses value equality instead of
  // reference equality — prevents unnecessary MIDI URL re-fetches on every 3-second poll
  // (each poll creates a new object reference even when the keys haven't changed).
  const midiFileKeysJson = JSON.stringify(sheet?.midiFileKeys ?? null);

  // Load MIDI URLs when sheet is ready, and refresh them every 4 minutes
  // (cloud storage pre-signed URLs expire after 5 min)
  useEffect(() => {
    let isCancelled = false;

    const loadMidiUrls = async () => {
      if (sheet?.status === "ready" && sheet.midiFileKeys && !isCancelled) {
        const keys = sheet.midiFileKeys as Record<string, string>;
        const voices = Object.keys(keys);

        const results = await Promise.allSettled(
          voices.map((voice) =>
            utils.sheetMusic.getMidiUrl
              .fetch({ id: sheetId, voice })
              .then((result) => ({ voice, url: result.url }))
          )
        );

        if (isCancelled) return;

        const urls: Record<string, string> = {};
        const failed: string[] = [];

        results.forEach((result, i) => {
          if (result.status === "fulfilled") {
            urls[result.value.voice] = result.value.url;
          } else {
            failed.push(voices[i]);
            console.error(`Failed to load MIDI URL for ${voices[i]}:`, result.reason);
          }
        });

        if (failed.length > 0 && failed.length < voices.length) {
          toast.warning(`Could not load MIDI for: ${failed.join(", ")}`);
        } else if (failed.length === voices.length) {
          toast.error("Failed to load all MIDI URLs");
        }

        setMidiUrls(urls);
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
  }, [sheet?.status, midiFileKeysJson, sheetId]); // midiFileKeysJson replaces sheet?.midiFileKeys (F-06)

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
  const deepConfidence = (analysis?.deepCorrectionConfidence ?? null) as ConfidenceData | null;
  const flaggedCount = deepConfidence
    ? deepConfidence.per_measure.filter(m => m.confidence < 0.9).length
    : 0;
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
                  {processingStep ?? sheet.errorMessage ?? "Processing your sheet music…"}
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
            {analysis?.warnings?.length > 0 && (
              <div className="flex items-center gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <div className="text-sm">
                  {analysis.warnings.map((w: string, i: number) => (
                    <p key={i}>{w}</p>
                  ))}
                </div>
              </div>
            )}
            {/* Deep-correction confidence banner */}
            {deepConfidence && (
              flaggedCount > 0 ? (
                <div className="flex items-center gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">
                    ⚠️ {flaggedCount} measure{flaggedCount !== 1 ? "s" : ""} flagged for review
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-yellow-800 dark:text-yellow-400 underline font-medium"
                    onClick={openReviewMode}
                  >
                    Review Score
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">✅ AI verification passed — all measures high confidence</span>
                </div>
              )
            )}

            <Card className="p-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-xl font-semibold">Voice Assignments</h2>
                  <div className="flex gap-2">
                    {sheet.musicxmlKey && deepConfidence && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openReviewMode}
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        Review Score
                      </Button>
                    )}
                    {sheet.musicxmlKey && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          if (!musicxmlContent && sheet.musicxmlKey) {
                            const res = await fetch(`/files/${sheet.musicxmlKey}`);
                            const xml = await res.text();
                            setMusicxmlContent(xml);
                          }
                          setIsEditing(true);
                        }}
                      >
                        <Pencil className="h-4 w-4 mr-2" />
                        Edit Score
                      </Button>
                    )}
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
              <PlaybackSyncProvider>
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold">MIDI Player</h2>
                    {sheet.musicxmlKey && (
                      <Button
                        variant={followScore ? "default" : "outline"}
                        size="sm"
                        onClick={toggleFollowScore}
                      >
                        <BookOpen className="h-4 w-4 mr-2" />
                        {followScore ? "Hide Score" : "Follow Score"}
                      </Button>
                    )}
                  </div>
                  <MidiPlayer
                    midiUrls={midiUrls}
                    availableVoices={availableVoices}
                    sheetTitle={sheet.title}
                  />
                </div>

                {/* Inline score-following view */}
                {followScore && musicxmlContent && (
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center h-32">
                        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
                      </div>
                    }
                  >
                    <div className="mt-4 border rounded-lg overflow-hidden" style={{ height: "480px" }}>
                      <NotationEditor
                        musicxml={musicxmlContent}
                        pdfUrl={null}
                        onSave={() => {}}
                        isSaving={false}
                        mode="follow"
                        className="h-full"
                      />
                    </div>
                  </Suspense>
                )}
              </PlaybackSyncProvider>
            )}
          </>
        )}
      </div>

      {isEditing && musicxmlContent && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 bg-background flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          }
        >
          <div className="fixed inset-0 z-50 bg-background">
            <div className="flex items-center justify-between p-2 border-b">
              <h3 className="font-semibold">{sheet.title} — Notation Editor</h3>
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
                Close
              </Button>
            </div>
            <NotationEditor
              musicxml={musicxmlContent}
              pdfUrl={sheet.originalFileKey ? `/files/${sheet.originalFileKey}` : null}
              onSave={(xml) => updateMusicXMLMutation.mutate({ id: sheetId, musicxml: xml })}
              isSaving={updateMusicXMLMutation.isPending}
              className="h-[calc(100vh-49px)]"
            />
          </div>
        </Suspense>
      )}

      {/* Review mode — shows confidence overlays + flag navigation + Approve */}
      {isReviewing && musicxmlContent && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 bg-background flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          }
        >
          <div className="fixed inset-0 z-50 bg-background">
            <div className="flex items-center justify-between p-2 border-b">
              <h3 className="font-semibold">{sheet.title} — Review Score</h3>
              <Button variant="ghost" size="sm" onClick={() => setIsReviewing(false)}>
                Close
              </Button>
            </div>
            <NotationEditor
              musicxml={musicxmlContent}
              pdfUrl={sheet.originalFileKey ? `/files/${sheet.originalFileKey}` : null}
              onSave={(xml) => updateMusicXMLMutation.mutate({ id: sheetId, musicxml: xml })}
              isSaving={updateMusicXMLMutation.isPending}
              mode="review"
              confidence={deepConfidence}
              onApprove={(xml) => updateMusicXMLMutation.mutate({ id: sheetId, musicxml: xml })}
              className="h-[calc(100vh-49px)]"
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}

