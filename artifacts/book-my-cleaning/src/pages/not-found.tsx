import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-secondary text-center px-4">
      <h1 className="font-serif text-6xl font-bold text-muted-foreground mb-4">
        404
      </h1>
      <p className="text-xl text-muted-foreground mb-8">Page not found</p>
      <Link href="/">
        <Button size="lg" className="rounded-full">
          Return Home
        </Button>
      </Link>
    </div>
  );
}
