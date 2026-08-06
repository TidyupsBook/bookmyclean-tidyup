import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene8() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600), // logo scale
      setTimeout(() => setPhase(2), 1200), // text fade in
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center w-full h-full bg-bg-dark"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1 }}
    >
      <div className="flex flex-col items-center justify-center text-center">
        {/* Logo */}
        <motion.div
          className="w-[10vw] h-[10vw] rounded-[2.5vw] brand-gradient-bg flex items-center justify-center shadow-[0_0_80px_rgba(236,72,153,0.3)] mb-[3vw]"
          initial={{ scale: 0, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", bounce: 0.5, duration: 1.2 }}
        >
          <img
            src={`${import.meta.env.BASE_URL}logo.svg`}
            alt="Logo"
            className="w-[5vw] h-[5vw]"
          />
        </motion.div>

        {/* Text */}
        <motion.h1
          className="text-[5vw] font-display font-bold leading-tight tracking-tight mb-[1vw]"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
        >
          Book My <span className="brand-gradient-text">Cleaning</span>
        </motion.h1>

        <motion.p
          className="text-[1.8vw] text-text-secondary font-medium tracking-wide"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          The AI receptionist for home services.
        </motion.p>
      </div>
    </motion.div>
  );
}
