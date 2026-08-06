import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600), // phone appears
      setTimeout(() => setPhase(2), 1200), // message 1
      setTimeout(() => setPhase(3), 2000), // link glow
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center w-full h-full"
      initial={{ opacity: 0, x: "10vw" }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, scale: 1.1 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-row items-center justify-center gap-[10vw] w-[80vw] mx-auto">
        {/* Phone mock */}
        <motion.div
          className="w-[24vw] h-[48vw] max-h-[85vh] bg-white rounded-[3vw] shadow-[0_0_50px_rgba(255,255,255,0.1)] relative overflow-hidden flex flex-col"
          initial={{ y: "20vh", opacity: 0, rotate: -5 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          transition={{ duration: 1, type: "spring", bounce: 0.3 }}
        >
          {/* Header */}
          <div className="h-[8%] w-full bg-gray-100 flex items-center justify-center border-b border-gray-200">
            <div className="text-[1.2vw] font-semibold text-gray-800">
              Tidyups Cleaning
            </div>
          </div>

          <div className="flex-1 p-[2vw] flex flex-col gap-[1vw] bg-gray-50">
            <div className="text-center text-[0.9vw] text-gray-400 font-medium mb-[1vw]">
              Today 2:14 PM
            </div>

            {/* Message Bubble */}
            <motion.div
              className="bg-gray-200 text-gray-800 p-[1.5vw] rounded-[1.5vw] rounded-tl-none self-start max-w-[85%] text-[1.2vw] leading-snug shadow-sm"
              initial={{
                opacity: 0,
                y: 20,
                scale: 0.9,
                transformOrigin: "bottom left",
              }}
              animate={phase >= 2 ? { opacity: 1, y: 0, scale: 1 } : {}}
              transition={{ type: "spring", bounce: 0.5 }}
            >
              Hi! Your move-out clean is scheduled for Friday. The total is
              $350.
              <br />
              <br />
              Tap here to approve and pay the deposit:
              <br />
              <motion.span
                className="text-blue-500 font-semibold inline-block mt-[0.5vw]"
                animate={
                  phase >= 3
                    ? {
                        textShadow: [
                          "0px 0px 0px rgba(59,130,246,0)",
                          "0px 0px 20px rgba(59,130,246,0.8)",
                          "0px 0px 0px rgba(59,130,246,0)",
                        ],
                      }
                    : {}
                }
                transition={{ duration: 1.5, repeat: Infinity }}
              >
                tidyups.com/q/8a2f
              </motion.span>
            </motion.div>
          </div>
        </motion.div>

        {/* Copy */}
        <div className="flex flex-col gap-[1vw] w-[35vw]">
          <motion.h2
            className="text-[4vw] font-display font-bold leading-tight"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
          >
            Closes the loop <br />
            <span className="text-secondary">via text.</span>
          </motion.h2>
          <motion.p
            className="text-[1.5vw] text-text-secondary leading-relaxed"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
          >
            The customer instantly gets a text with their price and a secure
            link to confirm.
          </motion.p>
        </div>
      </div>
    </motion.div>
  );
}
