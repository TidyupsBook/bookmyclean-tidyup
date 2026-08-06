import type {
  Company,
  Service,
  TranscriptSegment,
  ExtractedAnswer,
} from "@workspace/db";

const CALLER_NAMES = [
  "Maria Lopez",
  "James Carter",
  "Priya Patel",
  "Dana Whitfield",
  "Tom Nguyen",
  "Angela Brooks",
];

const ADDRESSES = [
  "412 Maple Street",
  "78 Sunset Terrace",
  "1509 Birchwood Lane",
  "23 Harbor View Drive",
  "660 Cedar Court",
];

const PREFERRED_TIMES = [
  "Friday morning",
  "next Tuesday afternoon",
  "this Saturday around 10am",
  "Monday after 2pm",
  "Thursday morning",
];

const FIELD_ANSWERS: Record<string, (ctx: SimContext) => string> = {
  name: (c) => c.callerName,
  address: (c) => c.address,
  "service type": (c) => c.serviceName,
  "home size": () => "3 bed, 2 bath, about 1,800 sq ft",
  pets: () => "One dog, very friendly",
  "preferred date": (c) => c.preferredTime,
  budget: (c) => c.budget,
  "how-did-you-hear": () => "Found you on Google",
};

const FIELD_QUESTIONS: Record<string, string> = {
  name: "Can I get your name, please?",
  address: "What's the address for the cleaning?",
  "service type": "What kind of cleaning are you looking for?",
  "home size": "How big is your home — bedrooms and bathrooms?",
  pets: "Do you have any pets we should know about?",
  "preferred date": "When would you like us to come by?",
  budget: "Do you have a budget in mind?",
  "how-did-you-hear": "How did you hear about us?",
};

type SimContext = {
  callerName: string;
  address: string;
  serviceName: string;
  preferredTime: string;
  budget: string;
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function buildSimulatedCall(company: Company, services: Service[]) {
  const service = services.length > 0 ? pick(services) : null;
  const ctx: SimContext = {
    callerName: pick(CALLER_NAMES),
    address: pick(ADDRESSES),
    serviceName: service ? service.name : "a deep clean",
    preferredTime: pick(PREFERRED_TIMES),
    budget: service
      ? service.priceMin != null && service.priceMax != null
        ? `Somewhere around $${Math.round((service.priceMin + service.priceMax) / 2)}`
        : "Varies by job"
      : "Around $200",
  };

  const transcript: TranscriptSegment[] = [];
  const extractedAnswers: ExtractedAnswer[] = [];
  let t = 0;
  const say = (speaker: "caller" | "ai", text: string, gap = 6) => {
    transcript.push({ speaker, text, offsetSeconds: t });
    t += gap;
  };

  const greeting =
    company.greeting ||
    `Thanks for calling ${company.name}! How can I help you today?`;
  say("ai", greeting);
  say(
    "caller",
    `Hi, I'd like to get a quote for ${ctx.serviceName.toLowerCase()}.`,
  );

  if (service) {
    say(
      "ai",
      `Of course! Our ${service.name} typically runs between $${service.priceMin} and $${service.priceMax}. Let me grab a few details.`,
    );
  } else {
    say("ai", "Happy to help with that! Let me grab a few details.");
  }

  const fields =
    company.collectFields.length > 0
      ? company.collectFields
      : ["name", "address", "preferred date"];

  for (const field of fields) {
    const q = FIELD_QUESTIONS[field] ?? `Could you tell me your ${field}?`;
    const a =
      FIELD_ANSWERS[field]?.(ctx) ?? "Sure, I'll get back to you on that.";
    say("ai", q, 4);
    say("caller", a, 5);
    extractedAnswers.push({ field, value: a });
  }

  for (const cq of company.customQuestions.slice(0, 2)) {
    say("caller", cq.question, 4);
    say("ai", cq.answer, 5);
  }

  say(
    "ai",
    `Perfect, ${ctx.callerName.split(" ")[0]}. I have you down for ${ctx.serviceName.toLowerCase()} on ${ctx.preferredTime}. We'll confirm shortly — anything else I can help with?`,
  );
  say("caller", "No, that's everything. Thank you!");
  say("ai", "Wonderful. We look forward to seeing you. Have a great day!");

  return {
    ctx,
    service,
    transcript,
    extractedAnswers,
    durationSeconds: t + 4,
  };
}
