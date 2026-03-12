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

  return (
    <QueryClientProvider client={queryClient}>
      {/* GLOBAL AUTH BUTTON */}
      <div
        style={{
          position: "fixed",
          top: 20,
          right: 20,
          zIndex: 1000,
        }}
      >
        {isLoggedIn === false && (
          <a href="/api/login">
            <button>Login</button>
          </a>
        )}
        {isLoggedIn === true && (
          <a href="/api/logout">
            <button>Logout</button>
          </a>
        )}
      </div>
      <Toaster />
      <Router />
    </QueryClientProvider>
  );
}

export default App;
