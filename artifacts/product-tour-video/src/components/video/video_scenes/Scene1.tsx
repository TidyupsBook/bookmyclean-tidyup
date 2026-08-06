import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600),
      setTimeout(() => setPhase(2), 1400),
      setTimeout(() => setPhase(3), 2600),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center w-full h-full"
      initial={{ opacity: 0, scale: 1.05 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, x: "-10vw", filter: "blur(10px)" }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-row items-center justify-between w-[80vw] mx-auto">
        {/* Left: Phone UI */}
        <motion.div
          className="w-[24vw] h-[48vw] max-h-[85vh] bg-bg-card rounded-[2.5vw] border border-white/10 shadow-[0_0_80px_rgba(236,72,153,0.15)] relative overflow-hidden flex flex-col"
          initial={{ y: "20vh", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 1, type: "spring", bounce: 0.3 }}
        >
          {/* Header */}
          <div className="h-[10%] w-full flex justify-center items-end pb-[1vw]">
            <div className="w-[30%] h-[0.4vw] bg-white/20 rounded-full"></div>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center p-[2vw]">
            <motion.div
              className="w-[8vw] h-[8vw] rounded-full brand-gradient-bg flex items-center justify-center shadow-[0_0_40px_rgba(168,85,247,0.4)] relative"
              animate={{
                scale: phase >= 1 ? [1, 1.1, 1] : 1,
              }}
              transition={{
                duration: 2,
                repeat: phase >= 1 ? Infinity : 0,
                ease: "easeInOut",
              }}
            >
              <div className="absolute inset-0 rounded-full border border-white/30" />
              <svg
                className="w-[3.5vw] h-[3.5vw] text-white relative z-10"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                />
              </svg>
            </motion.div>

            <motion.p className="mt-[3vh] text-[1.2vw] text-white/50 font-medium tracking-wide font-mono">
              {phase === 0 ? "Connecting..." : "00:12"}
            </motion.p>
          </div>

          <div className="h-[25%] w-full bg-white/[0.03] border-t border-white/10 flex flex-col justify-end p-[2vw] gap-[0.8vw]">
            <motion.div
              className="text-[1.1vw] text-white/90 leading-tight bg-white/10 p-[1vw] rounded-[1vw] rounded-bl-none self-start max-w-[85%]"
              initial={{
                opacity: 0,
                y: 10,
                scale: 0.9,
                transformOrigin: "bottom left",
              }}
              animate={{
                opacity: phase >= 2 ? 1 : 0,
                y: phase >= 2 ? 0 : 10,
                scale: phase >= 2 ? 1 : 0.9,
              }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            >
              Hi, I need a move-out clean...
            </motion.div>
            <motion.div
              className="text-[1.1vw] text-white/90 leading-tight bg-white/10 p-[1vw] rounded-[1vw] rounded-bl-none self-start max-w-[85%]"
              initial={{
                opacity: 0,
                y: 10,
                scale: 0.9,
                transformOrigin: "bottom left",
              }}
              animate={{
                opacity: phase >= 3 ? 1 : 0,
                y: phase >= 3 ? 0 : 10,
                scale: phase >= 3 ? 1 : 0.9,
              }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            >
              For a 3 bed, 2 bath house.
            </motion.div>
          </div>
        </motion.div>

        {/* Right: Copy */}
        <div className="flex flex-col gap-[1.5vw] w-[40vw]">
          <motion.h1
            className="text-[4.5vw] font-display font-bold leading-[1.1]"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            Never miss <br />a{" "}
            <span className="brand-gradient-text">booking</span> again.
          </motion.h1>
          <motion.p
            className="text-[1.6vw] text-text-secondary leading-relaxed"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            The AI agent answers every call instantly. Nights, weekends, or
            while you're deep cleaning a kitchen.
          </motion.p>
        </div>
      </div>
    </motion.div>
  );
}
