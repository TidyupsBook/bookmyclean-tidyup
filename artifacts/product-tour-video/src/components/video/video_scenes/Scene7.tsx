import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene7() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500), // dashboard scale in
      setTimeout(() => setPhase(2), 1200), // activity feed pops
      setTimeout(() => setPhase(3), 2000), // live call active
      setTimeout(() => setPhase(4), 2800), // stats update
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 w-full h-full flex flex-col pt-[5vh] items-center"
      initial={{ opacity: 0, y: "20vh" }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 1.1, filter: "blur(20px)" }}
      transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
    >
      <motion.h2
        className="text-[3vw] font-display font-bold mb-[3vh] z-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
      >
        Everything in <span className="brand-gradient-text">one view.</span>
      </motion.h2>

      <div className="w-[85vw] h-[75vh] bg-[#0A080C] rounded-[2vw] border border-white/10 shadow-[0_0_100px_rgba(236,72,153,0.15)] overflow-hidden flex flex-col font-body text-white relative">
        {/* Top Nav */}
        <div className="h-[8vh] border-b border-white/5 flex items-center px-[2vw] justify-between">
          <div className="flex items-center gap-[1vw]">
            <div className="w-[2vw] h-[2vw] brand-gradient-bg rounded-[0.5vw] flex items-center justify-center">
              <img
                src={`${import.meta.env.BASE_URL}logo.svg`}
                alt="Logo"
                className="w-[1vw] h-[1vw]"
              />
            </div>
            <span className="font-bold text-[1.2vw]">Tidyups Command</span>
          </div>
          <div className="flex gap-[2vw] text-[1vw] text-white/50">
            <span className="text-white font-medium">Dashboard</span>
            <span>Calls</span>
            <span>Bookings</span>
            <span>Quotes</span>
          </div>
          <div className="w-[2vw] h-[2vw] rounded-full bg-white/10 border border-white/20"></div>
        </div>

        {/* Dashboard Grid */}
        <div className="flex-1 flex p-[2vw] gap-[2vw]">
          {/* Left Column */}
          <div className="w-[25%] flex flex-col gap-[2vw]">
            {/* Stats */}
            <div className="bg-white/5 border border-white/5 rounded-[1vw] p-[1.5vw] flex flex-col gap-[1vw]">
              <div className="text-[1vw] text-white/50 font-medium">
                Today's Revenue
              </div>
              <motion.div
                className="text-[2.5vw] font-display font-bold"
                animate={phase >= 4 ? { color: "#10b981" } : {}}
                transition={{ duration: 0.5 }}
              >
                ${phase >= 4 ? "1,250" : "900"}
              </motion.div>
            </div>

            {/* Live Call */}
            <div className="flex-1 bg-white/5 border border-white/5 rounded-[1vw] p-[1.5vw] flex flex-col relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-[0.2vw] bg-white/5">
                {phase >= 3 && (
                  <motion.div
                    className="h-full brand-gradient-bg"
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: 3 }}
                  />
                )}
              </div>
              <div className="flex items-center justify-between mb-[1.5vw]">
                <div className="text-[1vw] text-white/50 font-medium">
                  Live Agent
                </div>
                <motion.div
                  className="w-[0.8vw] h-[0.8vw] bg-red-500 rounded-full"
                  initial={{ opacity: 0 }}
                  animate={
                    phase >= 3 ? { opacity: [1, 0.5, 1] } : { opacity: 0 }
                  }
                  transition={
                    phase >= 3
                      ? { duration: 1, repeat: Infinity }
                      : { duration: 0.1 }
                  }
                />
              </div>
              <div className="flex-1 flex items-center justify-center">
                <div
                  className={`text-[1.2vw] ${phase >= 3 ? "text-white" : "text-white/30"}`}
                >
                  {phase >= 3
                    ? '"Hi, checking my quote..."'
                    : "Waiting for call..."}
                </div>
              </div>
            </div>
          </div>

          {/* Middle Column */}
          <div className="w-[45%] bg-white/5 border border-white/5 rounded-[1vw] p-[1.5vw] flex flex-col">
            <div className="text-[1vw] text-white/50 font-medium mb-[1.5vw]">
              Recent Bookings
            </div>

            <div className="flex flex-col gap-[1vw]">
              {[1, 2, 3].map((_, i) => (
                <motion.div
                  key={i}
                  className="bg-white/5 p-[1vw] rounded-[0.8vw] flex items-center justify-between"
                  initial={{ opacity: 0, x: -20 }}
                  animate={phase >= 1 ? { opacity: 1, x: 0 } : {}}
                  transition={{ delay: 0.5 + i * 0.1 }}
                >
                  <div className="flex flex-col">
                    <span className="font-bold text-[1.1vw]">
                      Standard Clean
                    </span>
                    <span className="text-[0.9vw] text-white/50">
                      456 Elm St
                    </span>
                  </div>
                  <div className="bg-primary/20 text-primary text-[0.8vw] px-[0.8vw] py-[0.3vw] rounded-full">
                    Confirmed
                  </div>
                </motion.div>
              ))}

              {/* New Booking animating in */}
              <motion.div
                className="bg-white/10 border border-primary/30 p-[1vw] rounded-[0.8vw] flex items-center justify-between"
                initial={{ opacity: 0, height: 0, marginTop: "-1vw" }}
                animate={
                  phase >= 2 ? { opacity: 1, height: "auto", marginTop: 0 } : {}
                }
                transition={{ type: "spring", bounce: 0.4 }}
              >
                <div className="flex flex-col">
                  <span className="font-bold text-[1.1vw]">Move-Out Clean</span>
                  <span className="text-[0.9vw] text-white/50">
                    123 Main St • AI Booked
                  </span>
                </div>
                <div className="bg-primary text-white text-[0.8vw] px-[0.8vw] py-[0.3vw] rounded-full">
                  Deposit Paid
                </div>
              </motion.div>
            </div>
          </div>

          {/* Right Column: Activity Feed */}
          <div className="w-[30%] bg-white/5 border border-white/5 rounded-[1vw] p-[1.5vw] flex flex-col">
            <div className="text-[1vw] text-white/50 font-medium mb-[1.5vw]">
              Activity Feed
            </div>
            <div className="flex flex-col gap-[1.5vw] relative">
              <div className="absolute left-[0.4vw] top-[1vw] bottom-[1vw] w-px bg-white/10" />

              <motion.div
                className="flex gap-[1vw] relative z-10"
                initial={{ opacity: 0, y: 10 }}
                animate={phase >= 2 ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.2 }}
              >
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-green-500 mt-[0.3vw]" />
                <div className="flex flex-col">
                  <span className="text-[0.9vw] text-white/50">Just now</span>
                  <span className="text-[1vw]">Jobber Sync Successful</span>
                </div>
              </motion.div>

              <motion.div
                className="flex gap-[1vw] relative z-10"
                initial={{ opacity: 0, y: 10 }}
                animate={phase >= 2 ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.1 }}
              >
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-primary mt-[0.3vw]" />
                <div className="flex flex-col">
                  <span className="text-[0.9vw] text-white/50">2 min ago</span>
                  <span className="text-[1vw]">Deposit Paid ($50)</span>
                </div>
              </motion.div>

              <motion.div
                className="flex gap-[1vw] relative z-10"
                initial={{ opacity: 0, y: 10 }}
                animate={phase >= 2 ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0 }}
              >
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-white/30 mt-[0.3vw]" />
                <div className="flex flex-col">
                  <span className="text-[0.9vw] text-white/50">5 min ago</span>
                  <span className="text-[1vw]">Quote Sent via SMS</span>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
