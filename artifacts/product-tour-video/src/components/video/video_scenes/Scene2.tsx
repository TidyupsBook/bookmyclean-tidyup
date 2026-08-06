import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400), // text appears
      setTimeout(() => setPhase(2), 1200), // highlights applied
      setTimeout(() => setPhase(3), 2000), // tags pop out
      setTimeout(() => setPhase(4), 2800), // secondary tags
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center w-full h-full"
      initial={{ opacity: 0, x: "10vw" }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, scale: 1.1, filter: "blur(10px)" }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-col items-center justify-center w-[80vw] mx-auto text-center z-10">
        <motion.h2
          className="text-[3vw] font-display font-bold mb-[4vw]"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          Extracts details <span className="text-text-muted">instantly</span>
        </motion.h2>

        <div className="relative bg-bg-card border border-white/10 rounded-[2vw] p-[4vw] shadow-2xl w-[60vw]">
          <motion.div
            className="text-[2.2vw] leading-relaxed text-white/80 font-medium"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
          >
            "Hi, I need a{" "}
            <span
              className={`transition-colors duration-500 ${phase >= 2 ? "text-primary" : ""}`}
            >
              move-out clean
            </span>{" "}
            for a{" "}
            <span
              className={`transition-colors duration-500 ${phase >= 2 ? "text-accent" : ""}`}
            >
              3 bedroom
            </span>
            ,{" "}
            <span
              className={`transition-colors duration-500 ${phase >= 2 ? "text-accent" : ""}`}
            >
              2 bath
            </span>{" "}
            house at{" "}
            <span
              className={`transition-colors duration-500 ${phase >= 2 ? "text-secondary" : ""}`}
            >
              123 Main St
            </span>{" "}
            this{" "}
            <span
              className={`transition-colors duration-500 ${phase >= 2 ? "text-primary" : ""}`}
            >
              Friday
            </span>
            ."
          </motion.div>

          {/* Floating Data Tags */}
          <div className="absolute inset-0 pointer-events-none">
            {/* Service Type */}
            <motion.div
              className="absolute top-[-3vw] left-[10vw] bg-primary/20 border border-primary/50 text-primary px-[1.5vw] py-[0.5vw] rounded-full text-[1.2vw] font-bold backdrop-blur-md shadow-[0_0_20px_rgba(236,72,153,0.3)]"
              initial={{ opacity: 0, scale: 0.5, y: 20 }}
              animate={phase >= 3 ? { opacity: 1, scale: 1, y: 0 } : {}}
              transition={{ type: "spring", bounce: 0.5 }}
            >
              Move-Out Clean
            </motion.div>

            {/* Bedrooms */}
            <motion.div
              className="absolute top-[-2vw] right-[25vw] bg-accent/20 border border-accent/50 text-accent px-[1.5vw] py-[0.5vw] rounded-full text-[1.2vw] font-bold backdrop-blur-md shadow-[0_0_20px_rgba(168,85,247,0.3)]"
              initial={{ opacity: 0, scale: 0.5, y: 20 }}
              animate={phase >= 3 ? { opacity: 1, scale: 1, y: 0 } : {}}
              transition={{ type: "spring", bounce: 0.5, delay: 0.1 }}
            >
              3 Beds
            </motion.div>

            {/* Bathrooms */}
            <motion.div
              className="absolute top-[3vw] right-[10vw] bg-accent/20 border border-accent/50 text-accent px-[1.5vw] py-[0.5vw] rounded-full text-[1.2vw] font-bold backdrop-blur-md shadow-[0_0_20px_rgba(168,85,247,0.3)]"
              initial={{ opacity: 0, scale: 0.5, y: 20 }}
              animate={phase >= 3 ? { opacity: 1, scale: 1, y: 0 } : {}}
              transition={{ type: "spring", bounce: 0.5, delay: 0.2 }}
            >
              2 Baths
            </motion.div>

            {/* Address */}
            <motion.div
              className="absolute bottom-[-3vw] left-[20vw] bg-secondary/20 border border-secondary/50 text-secondary px-[1.5vw] py-[0.5vw] rounded-full text-[1.2vw] font-bold backdrop-blur-md shadow-[0_0_20px_rgba(255,123,84,0.3)]"
              initial={{ opacity: 0, scale: 0.5, y: -20 }}
              animate={phase >= 4 ? { opacity: 1, scale: 1, y: 0 } : {}}
              transition={{ type: "spring", bounce: 0.5 }}
            >
              123 Main St
            </motion.div>

            {/* Date */}
            <motion.div
              className="absolute bottom-[-2vw] right-[20vw] bg-primary/20 border border-primary/50 text-primary px-[1.5vw] py-[0.5vw] rounded-full text-[1.2vw] font-bold backdrop-blur-md shadow-[0_0_20px_rgba(236,72,153,0.3)]"
              initial={{ opacity: 0, scale: 0.5, y: -20 }}
              animate={phase >= 4 ? { opacity: 1, scale: 1, y: 0 } : {}}
              transition={{ type: "spring", bounce: 0.5, delay: 0.1 }}
            >
              Friday
            </motion.div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
