import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene4_Backend() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2500),
    ];
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden bg-bg-dark"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{
        opacity: 0,
        scale: 1.05,
        transition: { duration: 0.8, ease: "easeInOut" },
      }}
    >
      {/* Dark Grid Background */}
      <div
        className="absolute inset-0 opacity-20 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: "40px 40px",
          backgroundPosition: "center center",
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-bg-dark via-transparent to-bg-dark" />

      <div className="relative z-20 w-full max-w-7xl px-12 flex flex-col items-center">
        {/* Dashboard Mockup Layout */}
        <motion.div
          initial={{ opacity: 0, y: 100, rotateX: 20 }}
          animate={{ opacity: 1, y: 0, rotateX: 0 }}
          transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-5xl h-[400px] bg-[#0a0a0a] rounded-3xl border border-white/10 shadow-[0_0_80px_rgba(168,85,247,0.15)] flex flex-col overflow-hidden perspective-[1000px]"
        >
          {/* Header */}
          <div className="h-16 border-b border-white/10 flex items-center px-6 gap-4">
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full bg-error" />
              <div className="w-3 h-3 rounded-full bg-warning" />
              <div className="w-3 h-3 rounded-full bg-success" />
            </div>
            <div className="h-6 w-32 bg-white/5 rounded-md ml-4" />
          </div>

          {/* Content */}
          <div className="flex-1 flex p-6 gap-6">
            {/* Sidebar */}
            <div className="w-48 flex flex-col gap-4">
              <div className="h-8 bg-white/10 rounded-md w-full" />
              <div className="h-8 bg-white/5 rounded-md w-3/4" />
              <div className="h-8 bg-white/5 rounded-md w-5/6" />
            </div>

            {/* Main Area */}
            <div className="flex-1 flex flex-col gap-6">
              <div className="flex gap-4">
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={
                    phase >= 1
                      ? { opacity: 1, scale: 1 }
                      : { opacity: 0, scale: 0.9 }
                  }
                  transition={{ type: "spring", bounce: 0.4 }}
                  className="flex-1 h-24 bg-white/5 rounded-xl border border-white/5 p-4 flex flex-col justify-center"
                >
                  <div className="text-white/50 text-sm mb-2">Live Calls</div>
                  <div className="text-3xl font-display font-bold text-white">
                    12
                  </div>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={
                    phase >= 1
                      ? { opacity: 1, scale: 1 }
                      : { opacity: 0, scale: 0.9 }
                  }
                  transition={{ type: "spring", bounce: 0.4, delay: 0.1 }}
                  className="flex-1 h-24 bg-primary/10 rounded-xl border border-primary/20 p-4 flex flex-col justify-center"
                >
                  <div className="text-primary/70 text-sm mb-2">
                    Bookings Today
                  </div>
                  <div className="text-3xl font-display font-bold text-primary">
                    8
                  </div>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={
                    phase >= 1
                      ? { opacity: 1, scale: 1 }
                      : { opacity: 0, scale: 0.9 }
                  }
                  transition={{ type: "spring", bounce: 0.4, delay: 0.2 }}
                  className="flex-1 h-24 bg-white/5 rounded-xl border border-white/5 p-4 flex flex-col justify-center"
                >
                  <div className="text-white/50 text-sm mb-2">Revenue</div>
                  <div className="text-3xl font-display font-bold text-white">
                    $1,940
                  </div>
                </motion.div>
              </div>

              {/* Activity Feed */}
              <div className="flex-1 bg-white/5 rounded-xl border border-white/5 p-4 overflow-hidden relative">
                <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#111] to-transparent z-10" />
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={
                    phase >= 2 ? { y: 0, opacity: 1 } : { y: 20, opacity: 0 }
                  }
                  className="flex items-center gap-4 mb-4 bg-white/5 p-3 rounded-lg border-l-4 border-success"
                >
                  <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center text-success">
                    ✓
                  </div>
                  <div>
                    <div className="text-white font-medium">
                      New Booking: 124 Main St
                    </div>
                    <div className="text-white/50 text-sm">
                      $240 Deposit Paid
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-2 px-3 py-1 rounded-full bg-[#7DB00E]/20 text-[#7DB00E] border border-[#7DB00E]/30 text-xs font-bold">
                    SYNCED TO JOBBER
                  </div>
                </motion.div>
                <div className="flex items-center gap-4 mb-4 opacity-50">
                  <div className="w-10 h-10 rounded-full bg-white/10" />
                  <div className="flex-1 h-10 bg-white/10 rounded-lg" />
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Text Overlay */}
        <motion.div
          className="mt-12 text-center"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        >
          <h2 className="text-5xl font-display font-bold text-white mb-4">
            You just watch the bookings roll in.
          </h2>
          <p className="text-2xl text-text-muted">
            Live dashboard. Instant quotes.{" "}
            <span className="text-accent font-semibold">
              Jobber integration.
            </span>
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}
