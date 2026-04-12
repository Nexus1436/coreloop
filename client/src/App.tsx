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

function LandingPage() {
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
          Interloop
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

      <a href="/api/login" style={{ textDecoration: "none" }}>
        <button
          style={{
            backgroundColor: "transparent",
            border: "1px solid #555",
            color: "#ccc",
            padding: "12px 36px",
            fontSize: "0.9rem",
            letterSpacing: "0.1em",
            cursor: "pointer",
            borderRadius: "2px",
            transition: "all 0.2s ease",
          }}
          onMouseEnter={(e) => {
            (e.target as HTMLButtonElement).style.borderColor = "#fff";
            (e.target as HTMLButtonElement).style.color = "#fff";
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLButtonElement).style.borderColor = "#555";
            (e.target as HTMLButtonElement).style.color = "#ccc";
          }}
        >
          Login / Create Account
        </button>
      </a>
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
        <LandingPage />
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
              backgroundColor: "transparent",
              border: "1px solid #888",
              color: "#ddd",
              padding: "6px 16px",
              fontSize: "0.8rem",
              letterSpacing: "0.08em",
              cursor: "pointer",
              borderRadius: "2px",
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
