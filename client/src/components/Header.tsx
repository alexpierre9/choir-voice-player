import { Button } from "@/components/ui/button";
import { Moon, Sun, Music, LogIn, LogOut } from "lucide-react";
import { Link } from "wouter";
import { useTheme } from "../contexts/ThemeContext";
import { APP_TITLE } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";

export default function Header() {
  const { theme, toggleTheme } = useTheme();
  const { user, isAuthenticated, isLoading, login, logout } = useAuth();

  return (
    <header className="border-b bg-white/80 backdrop-blur-sm dark:bg-gray-900/80 dark:border-gray-700">
      <div className="container mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Music className="h-8 w-8 text-blue-600 dark:text-blue-400" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {APP_TITLE || "Choir Voice Player"}
          </h1>
        </div>

        <div className="flex items-center gap-4">
          {toggleTheme && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? (
                <Sun className="h-5 w-5 text-yellow-500" />
              ) : (
                <Moon className="h-5 w-5 text-gray-700" />
              )}
            </Button>
          )}

          {/* Auth controls — hidden while the session is being checked */}
          {!isLoading && (
            isAuthenticated ? (
              <div className="flex items-center gap-3">
                {user?.name && (
                  <span className="text-sm text-gray-600 dark:text-gray-300 hidden sm:block">
                    {user.name}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={logout}
                  aria-label="Sign out"
                >
                  <LogOut className="h-4 w-4 mr-1" />
                  Sign out
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/login">
                    <LogIn className="h-4 w-4 mr-1" />
                    Sign in
                  </Link>
                </Button>
                <Button variant="default" size="sm" asChild>
                  <Link href="/register">Get started</Link>
                </Button>
              </div>
            )
          )}
        </div>
      </div>
    </header>
  );
}
