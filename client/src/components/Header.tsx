import { Button } from "@/components/ui/button";
import { Moon, Sun, Music } from "lucide-react";
import { useTheme } from "../contexts/ThemeContext";
import { APP_LOGO, APP_TITLE } from "@/const";

export default function Header() {
  
  const { theme, toggleTheme } = useTheme();

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
          
          {isAuthenticated ? (
            <>
              <span className="text-sm text-gray-600 dark:text-gray-300 hidden sm:inline">
                {user?.name || user?.email}
              </span>
              <Button variant="outline" onClick={() => logout()} className="dark:border-gray-600 dark:text-white">
                Log Out
              </Button>
            </>
          ) : (
            <Button onClick={() => window.location.href = getLoginUrl()} className="dark:bg-blue-600 dark:hover:bg-blue-700">
              Log In
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}