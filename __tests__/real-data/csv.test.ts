import { parseCsvText } from "@/lib/real-data/csv";

describe("parseCsvText", () => {
  test("parses headers and rows", () => {
    expect(parseCsvText("id,outcome\n1,yes\n2,no")).toEqual({
      headers: ["id", "outcome"],
      rows: [
        { id: "1", outcome: "yes" },
        { id: "2", outcome: "no" },
      ],
    });
  });

  test("handles quoted commas", () => {
    const parsed = parseCsvText('id,note,outcome\n1,"left, right",0');
    expect(parsed.rows[0]).toEqual({
      id: "1",
      note: "left, right",
      outcome: "0",
    });
  });

  test("rejects inconsistent row width", () => {
    expect(() => parseCsvText("id,outcome\n1")).toThrow(
      "Row 2 has 1 columns; expected 2"
    );
  });
});
