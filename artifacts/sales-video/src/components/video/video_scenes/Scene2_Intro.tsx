import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene2_Intro() {
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
      className="absolute inset-0 flex items-center justify-center overflow-hidden bg-bg-light"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{
        opacity: 0,
        y: -50,
        transition: { duration: 0.8, ease: [0.22, 1, 0.36, 1] },
      }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Background Video */}
      <div className="absolute inset-0 z-0">
        <video
          src={`${import.meta.env.BASE_URL}videos/abstract-brand.mp4`}
          autoPlay
          muted
          loop
          playsInline
          className="w-full h-full object-cover scale-105 opacity-80"
        />
        <div className="absolute inset-0 bg-bg-light/40 z-10 mix-blend-overlay" />
        <div className="absolute inset-0 bg-gradient-to-br from-bg-light via-transparent to-bg-light z-10 opacity-90" />
      </div>

      <div className="relative z-20 flex flex-col items-center text-center max-w-5xl px-8">
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center gap-6"
        >
          <div className="w-32 h-32 md:w-40 md:h-40 bg-bg-dark rounded-3xl p-6 shadow-2xl border border-white/10 flex items-center justify-center relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-primary via-secondary to-accent opacity-20 group-hover:opacity-30 transition-opacity duration-1000" />
            <img
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt="Book My Cleaning Logo"
              className="w-full h-full object-contain drop-shadow-[0_0_15px_rgba(255,123,84,0.5)] relative z-10"
            />
          </div>

          <h1 className="text-5xl md:text-7xl font-display font-bold tracking-tight text-white mt-4">
            Book My Cleaning
          </h1>
          <p className="text-2xl font-body text-primary font-medium tracking-wide">
            BY TIDYUPS
          </p>
        </motion.div>

        <div className="mt-12 h-32 flex flex-col items-center justify-center">
          <motion.div
            initial={{ opacity: 0, y: 20, clipPath: "inset(100% 0 0 0)" }}
            animate={
              phase >= 1
                ? { opacity: 1, y: 0, clipPath: "inset(0% 0 0 0)" }
                : { opacity: 0, y: 20, clipPath: "inset(100% 0 0 0)" }
            }
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="text-3xl md:text-5xl font-display font-medium text-white/90 leading-tight"
          >
            An AI receptionist that answers
          </motion.div>

          <div className="flex gap-4 mt-4 overflow-hidden">
            <motion.span
              initial={{ opacity: 0, y: 20 }}
              animate={
                phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }
              }
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="text-4xl md:text-6xl font-display font-bold text-transparent bg-clip-text bg-gradient-to-r from-primary via-secondary to-accent"
            >
              every call.
            </motion.span>
            <motion.span
              initial={{ opacity: 0, scale: 0.5, rotate: -10 }}
              animate={
                phase >= 3
                  ? { opacity: 1, scale: 1, rotate: 0 }
                  : { opacity: 0, scale: 0.5, rotate: -10 }
              }
              transition={{ type: "spring", stiffness: 300, damping: 15 }}
              className="text-4xl md:text-6xl font-display font-bold text-white bg-white/10 px-6 py-2 rounded-2xl border border-white/20 backdrop-blur-sm"
            >
              24/7.
            </motion.span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
