export function Denied({ message }: { message: string }) {
  return (
    <div className="card max-w-lg">
      <h1 className="h1">No access</h1>
      <p className="mt-2 text-sm text-muted">{message}. Ask an administrator if you need this.</p>
    </div>
  );
}
