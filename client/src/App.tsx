import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import Home from "@/pages/home";
import NotFound from "@/pages/not-found";
import { useEffect, useState } from "react";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

/* =====================================================
   LANDING PAGE — shown to unauthenticated users
===================================================== */

function LandingPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitAuth = async (mode: "login" | "signup") => {
    if (isSubmitting) return;

    setAuthError("");
    setIsSubmitting(true);

    try {
      const response = await fetch(
        mode === "login" ? "/api/auth/login" : "/api/auth/signup",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            password,
          }),
        },
      );

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        setAuthError(errorBody?.message ?? "Authentication failed");
        return;
      }

      const userResponse = await fetch("/api/auth/user", {
        credentials: "include",
      });

      if (!userResponse.ok) {
        const errorBody = await userResponse.json().catch(() => null);
        setAuthError(errorBody?.message ?? "Unable to verify session");
        return;
      }

      onAuthenticated();
    } catch (_error) {
      setAuthError("Authentication failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        backgroundColor: "#000",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "32px",
        padding: "24px",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1
          style={{
            color: "#fff",
            fontSize: "2rem",
            fontWeight: 300,
            letterSpacing: "0.15em",
            marginBottom: "12px",
          }}
        >
          Coreloop
        </h1>
        <p
          style={{
            color: "#666",
            fontSize: "0.95rem",
            letterSpacing: "0.05em",
          }}
        >
          Movement intelligence. Built over time.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitAuth("login");
        }}
        style={{
          width: "100%",
          maxWidth: "340px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          style={{
            backgroundColor: "transparent",
            border: "1px solid #333",
            color: "#eee",
            padding: "12px 14px",
            fontSize: "0.95rem",
            borderRadius: "2px",
            outline: "none",
          }}
        />

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          style={{
            backgroundColor: "transparent",
            border: "1px solid #333",
            color: "#eee",
            padding: "12px 14px",
            fontSize: "0.95rem",
            borderRadius: "2px",
            outline: "none",
          }}
        />

        {authError && (
          <div
            style={{
              color: "#ff7a7a",
              fontSize: "0.85rem",
              lineHeight: 1.4,
              textAlign: "center",
            }}
          >
            {authError}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          style={{
            backgroundColor: "transparent",
            border: "1px solid #555",
            color: "#ccc",
            padding: "12px 24px",
            fontSize: "0.9rem",
            letterSpacing: "0.1em",
            cursor: isSubmitting ? "default" : "pointer",
            borderRadius: "2px",
            opacity: isSubmitting ? 0.6 : 1,
            transition: "all 0.2s ease",
          }}
          onMouseEnter={(e) => {
            if (isSubmitting) return;
            (e.target as HTMLButtonElement).style.borderColor = "#ffc83d";
            (e.target as HTMLButtonElement).style.color = "#ffc83d";
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLButtonElement).style.borderColor = "#555";
            (e.target as HTMLButtonElement).style.color = "#ccc";
          }}
        >
          Log In
        </button>

        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => submitAuth("signup")}
          style={{
            backgroundColor: "transparent",
            border: "1px solid #333",
            color: "#999",
            padding: "12px 24px",
            fontSize: "0.85rem",
            letterSpacing: "0.08em",
            cursor: isSubmitting ? "default" : "pointer",
            borderRadius: "2px",
            opacity: isSubmitting ? 0.6 : 1,
          }}
        >
          Create Account
        </button>
      </form>
    </div>
  );
}

/* =====================================================
   APP
===================================================== */

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/auth/user", { credentials: "include" })
      .then((res) => {
        if (res.ok) {
          setIsLoggedIn(true);
        } else {
          setIsLoggedIn(false);
        }
      })
      .catch(() => setIsLoggedIn(false));
  }, []);

  // Still checking auth — render nothing to avoid flash
  if (isLoggedIn === null) {
    return (
      <div
        style={{
          minHeight: "100vh",
          backgroundColor: "#000",
        }}
      />
    );
  }

  // Not logged in — show landing page, block app access
  if (isLoggedIn === false) {
    return (
      <QueryClientProvider client={queryClient}>
        <LandingPage onAuthenticated={() => setIsLoggedIn(true)} />
        <Toaster />
      </QueryClientProvider>
    );
  }

  // Logged in — show the full app with logout button
  return (
    <QueryClientProvider client={queryClient}>
      {/* LOGOUT BUTTON */}
      <div
        style={{
          position: "fixed",
          top: 20,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
        }}
      >
        <a href="/api/logout" style={{ textDecoration: "none" }}>
          <button
            style={{
              background:
                "linear-gradient(180deg, rgba(255,176,0,0.045), rgba(8,8,8,0.96))",
              border: "1px solid rgba(255,176,0,0.28)",
              color: "#ffc83d",
              padding: "6px 16px",
              fontSize: "0.8rem",
              letterSpacing: "0.08em",
              cursor: "pointer",
              borderRadius: "2px",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.color = "#ffd666";
              (e.target as HTMLButtonElement).style.borderColor =
                "rgba(255,184,0,0.48)";
              (e.target as HTMLButtonElement).style.textShadow =
                "0 0 10px rgba(255,184,0,0.25)";
              (e.target as HTMLButtonElement).style.boxShadow =
                "0 0 14px rgba(255,176,0,0.12)";
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.color = "#ffc83d";
              (e.target as HTMLButtonElement).style.borderColor =
                "rgba(255,176,0,0.28)";
              (e.target as HTMLButtonElement).style.textShadow = "none";
              (e.target as HTMLButtonElement).style.boxShadow = "none";
            }}
          >
            Logout
          </button>
        </a>
      </div>
      <Toaster />
      <Router />
    </QueryClientProvider>
  );
}

export default App;
