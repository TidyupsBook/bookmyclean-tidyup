import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene5_Outro() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 2000),
    ];
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 1 } }}
    >
      {/* Moving Gradient Background */}
      <motion.div
        className="absolute inset-[-50%] z-0 opacity-40"
        animate={{ rotate: 360 }}
        transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
        style={{
          background:
            "conic-gradient(from 0deg, var(--color-primary), var(--color-secondary), var(--color-accent), var(--color-primary))",
          filter: "blur(80px)",
        }}
      />
      <div className="absolute inset-0 bg-bg-light/80 z-0" />

      <div className="relative z-20 flex flex-col items-center text-center max-w-4xl px-8">
        {/* Sparkle Logo */}
        <motion.div
          initial={{ scale: 0, rotate: -45 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 20 }}
          className="mb-10 relative"
        >
          <div className="absolute inset-0 bg-gradient-to-tr from-primary to-accent blur-xl opacity-50" />
          <img
            src={`${import.meta.env.BASE_URL}logo.svg`}
            alt="Logo"
            className="w-32 h-32 md:w-48 md:h-48 relative z-10 drop-shadow-2xl"
          />
        </motion.div>

        {/* Main Headline */}
        <div className="overflow-hidden">
          <motion.h1
            initial={{ y: "100%" }}
            animate={phase >= 1 ? { y: 0 } : { y: "100%" }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="text-6xl md:text-8xl font-display font-bold text-white tracking-tight leading-tight"
          >
            Never miss
            <br />
            another job.
          </motion.h1>
        </div>

        {/* Brand Lockup */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="mt-12 pt-12 border-t border-white/10 w-full max-w-md mx-auto"
        >
          <div className="text-2xl font-display font-semibold text-white mb-2">
            Book My Cleaning
          </div>
          <div className="text-sm font-body text-text-muted tracking-[0.2em] uppercase">
            by Tidyups
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
