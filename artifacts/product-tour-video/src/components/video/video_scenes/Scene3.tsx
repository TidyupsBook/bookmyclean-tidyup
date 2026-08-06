import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600), // calendar loads
      setTimeout(() => setPhase(2), 1200), // new booking drops in
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // Calendar Grid Lines
  const hours = ["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM"];

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center w-full h-full"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, y: "10vh" }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-col items-center w-[80vw] mx-auto">
        <motion.h2
          className="text-[3.5vw] font-display font-bold mb-[3vw]"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          Booked <span className="brand-gradient-text">automatically</span>
        </motion.h2>

        <div className="w-[65vw] h-[50vh] bg-bg-card border border-white/10 rounded-[1.5vw] shadow-2xl flex overflow-hidden">
          {/* Times */}
          <div className="w-[8vw] border-r border-white/5 flex flex-col pt-[4vh]">
            {hours.map((hour, i) => (
              <div
                key={i}
                className="h-[6vh] text-[1vw] text-white/40 text-right pr-[1vw]"
              >
                {hour}
              </div>
            ))}
          </div>

          {/* Grid */}
          <div className="flex-1 relative pt-[4vh]">
            {hours.map((_, i) => (
              <div key={i} className="h-[6vh] border-b border-white/5 w-full" />
            ))}

            {/* Existing Booking */}
            <motion.div
              className="absolute left-[2vw] right-[35vw] top-[10vh] h-[11vh] bg-white/5 border border-white/10 rounded-[0.5vw] p-[1vw]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4 }}
            >
              <div className="text-[1vw] font-bold text-white/60">
                Standard Clean
              </div>
              <div className="text-[0.8vw] text-white/40">456 Elm St</div>
            </motion.div>

            {/* New Booking created from Call */}
            <motion.div
              className="absolute left-[30vw] right-[2vw] top-[22vh] h-[17vh] brand-gradient-bg rounded-[0.5vw] p-[1vw] shadow-[0_0_40px_rgba(236,72,153,0.4)] z-10 origin-center"
              initial={{ opacity: 0, scale: 1.5, filter: "blur(20px)" }}
              animate={
                phase >= 2 ? { opacity: 1, scale: 1, filter: "blur(0px)" } : {}
              }
              transition={{ type: "spring", bounce: 0.4, duration: 1 }}
            >
              <div className="flex items-center gap-[0.5vw] mb-[0.5vw]">
                <div className="w-[1.5vw] h-[1.5vw] bg-white text-primary rounded-full flex items-center justify-center">
                  <svg
                    className="w-[1vw] h-[1vw]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <div className="text-[1.2vw] font-bold text-white">
                  Move-Out Clean
                </div>
              </div>
              <div className="text-[1vw] text-white/90 font-medium">
                123 Main St
              </div>
              <div className="text-[0.9vw] text-white/80 mt-[0.5vw]">
                3 Bed, 2 Bath • AI Booked
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
