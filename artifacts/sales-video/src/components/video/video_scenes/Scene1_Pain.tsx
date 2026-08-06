import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene1_Pain() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 1600),
      setTimeout(() => setPhase(3), 2800),
    ];
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden bg-bg-light"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{
        scale: 1.1,
        filter: "blur(20px)",
        opacity: 0,
        transition: { duration: 0.8, ease: "easeInOut" },
      }}
    >
      {/* Background Video */}
      <div className="absolute inset-0 z-0">
        <video
          src={`${import.meta.env.BASE_URL}videos/vacuum-pain.mp4`}
          autoPlay
          muted
          loop
          playsInline
          className="w-full h-full object-cover scale-105"
        />
        {/* Dark Overlay */}
        <div className="absolute inset-0 bg-black/60 z-10 mix-blend-multiply" />
        <div className="absolute inset-0 bg-gradient-to-t from-bg-light via-transparent to-transparent z-10 opacity-90" />
      </div>

      {/* Foreground Content */}
      <div className="relative z-20 flex flex-col items-center text-center w-full max-w-4xl px-8">
        <motion.div className="flex flex-col items-center gap-6 mb-8 h-40 justify-end">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="text-4xl md:text-5xl font-display font-medium text-white/80"
          >
            You're mid-job.
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="text-4xl md:text-5xl font-display font-medium text-white"
          >
            The vacuum is running.
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.9, filter: "blur(10px)" }}
          animate={
            phase >= 3
              ? { opacity: 1, scale: 1, filter: "blur(0px)" }
              : { opacity: 0, scale: 0.9, filter: "blur(10px)" }
          }
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="mt-4 flex flex-col items-center gap-4"
        >
          <div className="flex items-center gap-4 text-primary bg-primary/10 px-8 py-4 rounded-full border border-primary/20 backdrop-blur-md shadow-[0_0_40px_rgba(255,123,84,0.3)]">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-10 w-10 animate-bounce"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.58 5.25a2 2 0 0 0-2.66 0l-4.5 4.5a2 2 0 0 0 0 2.82l.88.88a2 2 0 0 0 2.83 0l4.5-4.5a2 2 0 0 0 0-2.83z" />
              <path d="M16 4v6h-6" />
            </svg>
            <span className="text-5xl md:text-6xl font-display font-bold tracking-tight text-white">
              The phone rings.
            </span>
          </div>
          <motion.p
            initial={{ opacity: 0 }}
            animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ delay: 0.5, duration: 0.8 }}
            className="text-xl md:text-2xl font-body text-text-muted mt-2"
          >
            Missed calls = lost revenue.
          </motion.p>
        </motion.div>
      </div>
    </motion.div>
  );
}
