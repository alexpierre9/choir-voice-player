import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import Header from "@/components/Header";
import { APP_TITLE } from "@/const";
import { Music, Upload, Users, Volume2, Search } from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";

export default function Home() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  // Only fetch the list once we know the user is authenticated — avoids an
  // UNAUTHORIZED error (and the resulting redirect-to-login) for visitors
  // who land on the home page without a session.
  // F-07: also track isLoading so we can show a skeleton instead of a blank section
  const { data: userSheets, isLoading: sheetsLoading, isError: sheetsError } = trpc.sheetMusic.list.useQuery(undefined, {
    enabled: !!user,
  });

  const filteredSheets = userSheets
    ? search.trim()
      ? userSheets.filter(
          (s) =>
            s.title.toLowerCase().includes(search.toLowerCase()) ||
            s.originalFilename.toLowerCase().includes(search.toLowerCase())
        )
      : userSheets
    : undefined;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <Header />

      {/* Hero Section */}
      <div className="container mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
            Play Every Voice in Your Choir
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-2xl mx-auto">
            Upload sheet music and hear each SATB voice part individually. Perfect
            for choir practice, learning, and arrangement analysis.
          </p>

          <Button
            size="lg"
            onClick={() => setLocation("/upload")}
            className="text-lg px-8 py-6"
          >
            <Upload className="mr-2 h-5 w-5" />
            Upload Sheet Music
          </Button>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <Card className="p-6 text-center">
            <div className="bg-info-light dark:bg-info-light/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Upload className="h-8 w-8 text-info dark:text-info" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Easy Upload</h3>
            <p className="text-gray-600 dark:text-gray-300">
              Upload PDF or MusicXML files. Our AI analyzes the sheet music
              automatically.
            </p>
          </Card>

          <Card className="p-6 text-center">
            <div className="bg-success-light dark:bg-success-light/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Users className="h-8 w-8 text-success dark:text-success" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Auto Voice Detection</h3>
            <p className="text-gray-600 dark:text-gray-300">
              Automatically detects Soprano, Alto, Tenor, and Bass parts with
              manual override options.
            </p>
          </Card>

          <Card className="p-6 text-center">
            <div className="bg-purple-light dark:bg-purple-light/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Volume2 className="h-8 w-8 text-purple dark:text-purple" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Individual Playback</h3>
            <p className="text-gray-600 dark:text-gray-300">
              Play each voice separately or together. Control volume and mute
              individual parts.
            </p>
          </Card>
        </div>

        {/* Sheet Music Library */}
        {user && (
        <div>
          <div className="flex items-center justify-between mb-4 gap-4">
            <h3 className="text-2xl font-bold text-gray-900 dark:text-white whitespace-nowrap">
              Your Sheet Music
            </h3>
            {userSheets && userSheets.length > 0 && (
              <div className="relative max-w-xs w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            )}
          </div>

          {/* F-07: show skeleton while the list is fetching to avoid layout shift */}
          {sheetsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <Card key={i} className="p-4 animate-pulse dark:bg-gray-800 dark:border-gray-700">
                  <div className="flex items-start gap-3">
                    <div className="h-6 w-6 bg-gray-200 dark:bg-gray-600 rounded flex-shrink-0 mt-1" />
                    <div className="flex-1 space-y-2 py-1">
                      <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-3/4" />
                      <div className="h-3 bg-gray-200 dark:bg-gray-600 rounded w-1/2" />
                      <div className="h-5 bg-gray-200 dark:bg-gray-600 rounded w-14 mt-2" />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : sheetsError ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Could not load your uploads. Please refresh the page.
            </p>
          ) : filteredSheets && filteredSheets.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSheets.map((sheet) => (
                <Card
                  key={sheet.id}
                  className="p-4 hover:shadow-lg transition-shadow cursor-pointer dark:bg-gray-800 dark:border-gray-700"
                  onClick={() => setLocation(`/sheet/${sheet.id}`)}
                >
                  <div className="flex items-start gap-3">
                    <Music className="h-6 w-6 text-blue-500 flex-shrink-0 mt-1 dark:text-blue-400" />
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold truncate dark:text-white">{sheet.title}</h4>
                      <p className="text-sm text-gray-500 truncate dark:text-gray-400">
                        {sheet.originalFilename}
                      </p>
                      <div className="mt-2">
                        {sheet.status === "ready" && (
                          <span className="text-xs bg-success-light text-success px-2 py-1 rounded dark:bg-success-light/30 dark:text-success">
                            Ready
                          </span>
                        )}
                        {sheet.status === "processing" && (
                          <span className="text-xs bg-info-light text-info px-2 py-1 rounded dark:bg-info-light/30 dark:text-info">
                            Processing...
                          </span>
                        )}
                        {sheet.status === "error" && (
                          <span className="text-xs bg-error-light text-error px-2 py-1 rounded dark:bg-error-light/30 dark:text-error">
                            Error
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : search.trim() && userSheets && userSheets.length > 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4">
              No results for &ldquo;{search}&rdquo;.
            </p>
          ) : (
            <Card className="p-12 text-center dark:bg-gray-800 dark:border-gray-700">
              <div className="mx-auto max-w-md">
                <Music className="h-16 w-16 text-info mx-auto mb-4 dark:text-info" />
                <h4 className="text-xl font-semibold mb-2 dark:text-white">No Sheet Music Yet</h4>
                <p className="text-gray-600 mb-6 dark:text-gray-300">
                  You haven't uploaded any sheet music yet. Get started by uploading your first score.
                </p>
                <Button
                  size="lg"
                  onClick={() => setLocation("/upload")}
                  className="dark:bg-blue-600 dark:hover:bg-blue-700"
                >
                  <Upload className="mr-2 h-5 w-5" />
                  Upload Sheet Music
                </Button>
              </div>
            </Card>
          )}
        </div>
        )}

        {/* How It Works */}
        <div className="mt-16">
          <h3 className="text-2xl font-bold text-center text-gray-900 dark:text-white mb-8">
            How It Works
          </h3>
          <div className="max-w-3xl mx-auto space-y-6">
            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  1
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">Upload Your Score</h4>
                  <p className="text-gray-600 dark:text-gray-300">
                    Upload a PDF or MusicXML file of your choir arrangement. We
                    support both scanned PDFs (using optical music recognition) and
                    digital MusicXML files.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  2
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">
                    Automatic Voice Detection
                  </h4>
                  <p className="text-gray-600 dark:text-gray-300">
                    Our system analyzes the sheet music and automatically identifies
                    which parts belong to Soprano, Alto, Tenor, and Bass based on
                    clefs, pitch ranges, and part names.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  3
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">
                    Review and Adjust
                  </h4>
                  <p className="text-gray-600 dark:text-gray-300">
                    Check the detected voice assignments. If needed, manually adjust
                    which parts correspond to which voices using the dropdown menus.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  4
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">
                    Play and Practice
                  </h4>
                  <p className="text-gray-600 dark:text-gray-300">
                    Use the MIDI player to play each voice individually or together.
                    Control the volume of each part, mute voices, and follow along
                    with your score.
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t bg-white/80 backdrop-blur-sm mt-16">
        <div className="container mx-auto px-6 py-8 text-center text-gray-600">
          <p>© 2025 Choir Voice Player. Built for choir directors and singers.</p>
        </div>
      </footer>
    </div>
  );
}
