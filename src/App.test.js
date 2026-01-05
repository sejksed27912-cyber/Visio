import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders Visio 1 title", () => {
  render(<App />);
  const title = screen.getByText(/visio 1/i);
  expect(title).toBeInTheDocument();
});

test("renders copy link button", () => {
  render(<App />);
  const btn = screen.getByRole("button", { name: /copier le lien/i });
  expect(btn).toBeInTheDocument();
});
