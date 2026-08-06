import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene6() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600), // logos appear
      setTimeout(() => setPhase(2), 1200), // sync line active
      setTimeout(() => setPhase(3), 2000), // data packet moves
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center w-full h-full"
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, x: "-10vw" }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-col items-center justify-center w-[80vw] mx-auto text-center">
        <motion.h2
          className="text-[4vw] font-display font-bold mb-[5vw] z-10"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          Syncs with your{" "}
          <span className="brand-gradient-text">field tools</span>
        </motion.h2>

        <div className="flex items-center justify-center w-[50vw] relative">
          {/* Tidyups Side */}
          <motion.div
            className="w-[10vw] h-[10vw] bg-bg-card border border-white/10 rounded-[2.5vw] flex items-center justify-center shadow-[0_0_50px_rgba(236,72,153,0.2)] z-10 relative"
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", bounce: 0.4 }}
          >
            <div className="w-[5vw] h-[5vw] brand-gradient-bg rounded-[1vw] flex items-center justify-center">
              <img
                src={`${import.meta.env.BASE_URL}logo.svg`}
                alt="Logo"
                className="w-[2.5vw] h-[2.5vw]"
              />
            </div>
          </motion.div>

          {/* Sync Line */}
          <div className="flex-1 h-px bg-white/10 relative mx-[2vw]">
            <motion.div
              className="absolute left-0 top-1/2 -translate-y-1/2 h-[2px] brand-gradient-bg w-[0%]"
              animate={phase >= 2 ? { width: "100%" } : { width: "0%" }}
              transition={{ duration: 0.8, ease: "easeInOut" }}
            />
            {/* Data Packet */}
            <motion.div
              className="absolute left-0 top-1/2 -translate-y-1/2 w-[1.5vw] h-[1.5vw] bg-white rounded-full shadow-[0_0_20px_rgba(255,255,255,0.8)]"
              initial={{ scale: 0, x: 0 }}
              animate={
                phase >= 3
                  ? { scale: [0, 1, 1, 0], x: ["0%", "50%", "100%", "100%"] }
                  : { scale: 0 }
              }
              transition={{ duration: 1.2, ease: "easeInOut" }}
            />
          </div>

          {/* Jobber/Field App Side */}
          <motion.div
            className="w-[10vw] h-[10vw] bg-[#7db434]/10 border border-[#7db434]/30 rounded-[2.5vw] flex items-center justify-center shadow-[0_0_50px_rgba(125,180,52,0.2)] z-10"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", bounce: 0.4, delay: 0.2 }}
          >
            <div className="text-[1.8vw] font-bold text-[#7db434] tracking-tight">
              Jobber
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
