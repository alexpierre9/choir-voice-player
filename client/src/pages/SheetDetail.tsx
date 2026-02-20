import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Header from "@/components/Header";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, ArrowLeft, Music } from "lucide-react";
import { toast } from "sonner";
import MidiPlayer from "@/components/MidiPlayer";
import { useAuth } from "@/_core/hooks/useAuth";

const VOICE_OPTIONS = [
  { value: "soprano", label: "Soprano" },
  { value: "alto", label: "Alto" },
  { value: "tenor", label: "Tenor" },
  { value: "bass", label: "Bass" },
  { value: "other", label: "Other" },
];

export default function SheetDetail() {
  const { loading: authLoading } = useAuth({ redirectOnUnauthenticated: true });
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
        // Poll every 3 seconds if still processing to reduce backend load
        return query.state.data?.status === "processing" ? 3000 : false;
      },
      retry: 2, // Reduce retries to reduce backend load
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000), // Faster max delay
      staleTime: 1000, // Cache data for 1 second to reduce requests
      gcTime: 300000, // Keep unused data for 5 minutes
    }
  );

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

  // Show loading state while checking authentication
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  // Initialize voice assignments from sheet data
  useEffect(() => {
    if (sheet?.voiceAssignments) {
      setVoiceAssignments(sheet.voiceAssignments as Record<string, string>);
    }
  }, [sheet]);

  // Load MIDI URLs when sheet is ready
  useEffect(() => {
    // Use a ref to track if a load operation is in progress to prevent race conditions
    let isCancelled = false;
    
    const loadMidiUrls = async () => {
      if (sheet?.status === "ready" && sheet.midiFileKeys && !isCancelled) {
        const keys = sheet.midiFileKeys as Record<string, string>;
        const urls: Record<string, string> = {};

        for (const [voice, _] of Object.entries(keys)) {
          if (isCancelled) break; // Check if component unmounted
          
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

    if (sheet?.status === "ready" && sheet.midiFileKeys) {
      loadMidiUrls();
    }
    
    // Cleanup function to prevent state updates on unmounted components
    return () => {
      isCancelled = true;
    };
  }, [sheet?.status, sheet?.midiFileKeys, sheetId]); // Only re-run when status or midiFileKeys change

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
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{sheet.title}</h1>
            <p className="text-gray-600 dark:text-gray-300">{sheet.originalFilename}</p>
          </div>
        </div>

        {/* Processing Status */}
        {sheet.status === "processing" && (
          <Card className="p-6 bg-blue-50 border-blue-200" aria-live="polite" aria-atomic="true">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
              <div>
                <p className="font-medium">Processing your sheet music...</p>
                <p className="text-sm text-gray-600">
                  This may take a few minutes. The page will update automatically.
                </p>
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
                <Button onClick={() => setLocation("/")}>
                  Go Back
                </Button>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  Refresh Page
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
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold">Voice Assignments</h2>
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

                <p className="text-sm text-gray-600">
                  We automatically detected {analysis.total_parts} part(s). Adjust
                  the voice assignments if needed.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {analysis.parts.map((part: any) => (
                    <div
                      key={part.index}
                      className="p-4 border rounded-lg space-y-3"
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
                        Auto-detected: {part.detected_voice}
                      </div>
                    </div>
                  ))}
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

