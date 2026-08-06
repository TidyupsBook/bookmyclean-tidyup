import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600), // quote appears
      setTimeout(() => setPhase(2), 1500), // tap button
      setTimeout(() => setPhase(3), 1800), // apple pay sheet
      setTimeout(() => setPhase(4), 3000), // success check
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center w-full h-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: "-10vh" }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-col items-center justify-center w-[80vw] mx-auto text-center">
        <motion.h2
          className="text-[3.5vw] font-display font-bold mb-[3vw] z-10 relative"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          One tap to <span className="brand-gradient-text">approve & pay</span>
        </motion.h2>

        <div className="relative w-[28vw] h-[56vw] max-h-[85vh] bg-[#f8fafc] rounded-[3vw] shadow-2xl overflow-hidden text-left font-body">
          {/* Quote Header */}
          <div className="bg-white p-[2vw] pb-[1vw] pt-[4vw] border-b border-gray-100">
            <div className="w-[4vw] h-[4vw] brand-gradient-bg rounded-[1vw] mb-[1vw] flex items-center justify-center">
              <img
                src={`${import.meta.env.BASE_URL}logo.svg`}
                alt="Logo"
                className="w-[2vw] h-[2vw]"
              />
            </div>
            <h3 className="text-[1.8vw] font-bold text-gray-900">Your Quote</h3>
            <p className="text-[1vw] text-gray-500">123 Main St • Friday</p>
          </div>

          {/* Line Items */}
          <div className="p-[2vw] flex flex-col gap-[1vw]">
            <div className="flex justify-between items-center text-[1.2vw]">
              <span className="text-gray-700 font-medium">Move-Out Clean</span>
              <span className="text-gray-900 font-bold">$250</span>
            </div>
            <div className="flex justify-between items-center text-[1.2vw]">
              <span className="text-gray-700 font-medium">Oven Detail</span>
              <span className="text-gray-900 font-bold">$50</span>
            </div>
            <div className="flex justify-between items-center text-[1.2vw]">
              <span className="text-gray-700 font-medium">Inside Fridge</span>
              <span className="text-gray-900 font-bold">$50</span>
            </div>

            <div className="h-px bg-gray-200 my-[0.5vw]"></div>

            <div className="flex justify-between items-center text-[1.4vw] font-bold text-gray-900">
              <span>Total</span>
              <span>$350</span>
            </div>
          </div>

          {/* Pay Button */}
          <div className="absolute bottom-[2vw] left-[2vw] right-[2vw]">
            <motion.div
              className="bg-gray-900 text-white rounded-full py-[1.2vw] flex items-center justify-center gap-[0.5vw] font-bold text-[1.2vw] relative overflow-hidden"
              animate={phase === 2 ? { scale: 0.95 } : { scale: 1 }}
              transition={{ duration: 0.1 }}
            >
              Pay Deposit ($50)
              {phase >= 4 && (
                <motion.div
                  className="absolute inset-0 bg-green-500 flex items-center justify-center"
                  initial={{ y: "100%" }}
                  animate={{ y: 0 }}
                >
                  <svg
                    className="w-[1.5vw] h-[1.5vw]"
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
                </motion.div>
              )}
            </motion.div>
          </div>

          {/* Apple Pay Sheet Slide Up */}
          <motion.div
            className="absolute bottom-0 left-0 right-0 h-[40%] bg-white rounded-t-[2vw] shadow-[0_-10px_30px_rgba(0,0,0,0.1)] p-[2vw] flex flex-col items-center"
            initial={{ y: "100%" }}
            animate={phase >= 3 && phase < 4 ? { y: 0 } : { y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
          >
            <div className="text-[1.5vw] font-bold mb-[1vw] flex items-center gap-[0.5vw]">
              Pay with{" "}
              <span className="font-bold tracking-tighter">Apple Pay</span>
            </div>
            <div className="w-[4vw] h-[6vw] border-4 border-gray-900 rounded-[1vw] mb-[1vw] flex items-center justify-center relative">
              <motion.div
                className="w-full h-full bg-gray-900/10 absolute top-0 left-0 rounded-[0.5vw]"
                initial={{ height: 0 }}
                animate={{ height: "100%" }}
                transition={{ duration: 1, delay: 1.8 }}
              />
              <svg
                className="w-[2vw] h-[2vw] text-gray-900 z-10"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </div>
            <div className="text-[1vw] text-gray-500">Double click to pay</div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
