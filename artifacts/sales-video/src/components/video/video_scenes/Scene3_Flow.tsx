import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene3_Flow() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600),
      setTimeout(() => setPhase(2), 2200),
      setTimeout(() => setPhase(3), 3800),
    ];
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden bg-bg-light"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{
        opacity: 0,
        scale: 0.95,
        filter: "blur(10px)",
        transition: { duration: 0.8 },
      }}
    >
      {/* Background Animated Gradient Orbs */}
      <div className="absolute inset-0 z-0 overflow-hidden">
        <motion.div
          animate={{
            x: ["-10%", "10%", "-5%"],
            y: ["-10%", "5%", "10%"],
            rotate: [0, 90, 0],
          }}
          transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
          className="absolute top-0 left-[10%] w-[60vw] h-[60vw] rounded-full bg-primary/10 blur-[120px] mix-blend-screen"
        />
        <motion.div
          animate={{
            x: ["10%", "-10%", "5%"],
            y: ["10%", "-5%", "-10%"],
            rotate: [0, -90, 0],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          className="absolute bottom-0 right-[10%] w-[50vw] h-[50vw] rounded-full bg-secondary/10 blur-[100px] mix-blend-screen"
        />
      </div>

      <div className="relative z-20 flex w-full max-w-7xl px-12 items-center justify-between gap-16">
        {/* Left Side: Phone Mockup */}
        <motion.div
          initial={{ opacity: 0, x: -50, rotateY: 20, perspective: 1000 }}
          animate={{ opacity: 1, x: 0, rotateY: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          className="w-1/2 flex justify-center perspective-[1000px]"
        >
          <div className="w-[340px] h-[700px] bg-bg-dark rounded-[3rem] border-[8px] border-bg-muted shadow-2xl relative overflow-hidden flex flex-col p-4 shadow-[0_20px_50px_rgba(0,0,0,0.5),inset_0_0_20px_rgba(255,255,255,0.05)] transform-gpu">
            {/* Dynamic Content inside Phone based on phase */}
            <div className="w-full flex-1 flex flex-col gap-4 relative">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={
                  phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }
                }
                className="bg-bg-muted/50 rounded-2xl p-4 mt-8 border border-white/5"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                    <span className="text-primary text-xs font-bold">AI</span>
                  </div>
                  <div className="text-sm font-medium text-white/80">
                    Capturing Job...
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="h-2 w-3/4 bg-white/10 rounded-full" />
                  <div className="h-2 w-1/2 bg-white/10 rounded-full" />
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 50 }}
                animate={
                  phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: 50 }
                }
                transition={{ type: "spring", damping: 20, stiffness: 200 }}
                className="self-end bg-gradient-to-br from-primary to-secondary p-4 rounded-2xl rounded-tr-sm max-w-[85%] mt-auto mb-8 shadow-lg"
              >
                <p className="text-white text-sm font-medium">
                  Your quote is ready: $240. Tap here to approve & book!
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={
                  phase >= 3
                    ? { opacity: 1, scale: 1 }
                    : { opacity: 0, scale: 0.8 }
                }
                transition={{
                  type: "spring",
                  damping: 15,
                  stiffness: 300,
                  delay: 0.2,
                }}
                className="absolute inset-0 bg-bg-dark/95 backdrop-blur-md flex flex-col items-center justify-center z-10"
              >
                <div className="w-20 h-20 bg-success/20 rounded-full flex items-center justify-center mb-4">
                  <svg
                    className="w-10 h-10 text-success"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={3}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <div className="text-xl font-display font-bold text-white mb-1">
                  Deposit Paid
                </div>
                <div className="text-sm text-text-muted">Job Scheduled</div>
              </motion.div>
            </div>
          </div>
        </motion.div>

        {/* Right Side: Text Steps */}
        <div className="w-1/2 flex flex-col gap-8">
          <motion.div
            initial={{ opacity: 0, x: 50 }}
            animate={
              phase >= 1
                ? { opacity: phase === 1 ? 1 : 0.4, x: 0 }
                : { opacity: 0, x: 50 }
            }
            transition={{ duration: 0.6 }}
            className="flex flex-col gap-2"
          >
            <div className="text-primary font-bold text-xl tracking-wider uppercase">
              01
            </div>
            <h2 className="text-4xl font-display font-bold text-white leading-tight">
              Qualify & Capture
            </h2>
            <p className="text-xl text-text-muted">
              Collects address, rooms, and preferred date on the call.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 50 }}
            animate={
              phase >= 2
                ? { opacity: phase === 2 ? 1 : 0.4, x: 0 }
                : { opacity: 0, x: 50 }
            }
            transition={{ duration: 0.6 }}
            className="flex flex-col gap-2"
          >
            <div className="text-secondary font-bold text-xl tracking-wider uppercase">
              02
            </div>
            <h2 className="text-4xl font-display font-bold text-white leading-tight">
              Text a Quote
            </h2>
            <p className="text-xl text-text-muted">
              Sends a branded SMS link automatically.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 50 }}
            animate={phase >= 3 ? { opacity: 1, x: 0 } : { opacity: 0, x: 50 }}
            transition={{ duration: 0.6 }}
            className="flex flex-col gap-2"
          >
            <div className="text-accent font-bold text-xl tracking-wider uppercase">
              03
            </div>
            <h2 className="text-4xl font-display font-bold text-white leading-tight">
              One-Tap Booking
            </h2>
            <p className="text-xl text-text-muted">
              Customer approves and pays deposit online.
            </p>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
