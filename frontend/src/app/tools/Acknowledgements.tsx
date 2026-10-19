/**
 * Thanks to the researchers whose feedback shaped CAT.
 *
 * To credit someone, add an entry to CONTRIBUTORS. Only add a name with that
 * person's permission — this page is public — and keep it to name, role, and
 * institution. No email addresses, postal addresses, or other contact details.
 */

import { ContactForm } from "@/app/tools/HowToPage";

type Contributor = {
  name: string;
  role?: string;
  affiliation?: string[];
};

const CONTRIBUTORS: Contributor[] = [
  {
    name: "Emma Klein",
    role: "PhD Candidate in Behavioral and Experimental Economics",
    affiliation: [
      "GATE Lyon Saint-Étienne (UMR 5824, CNRS)",
      "Université Lumière Lyon 2",
    ],
  },
  {
    name: "Gonzalo Arrieta",
    role: "Postdoctoral Researcher",
    affiliation: [
      "Department of Economics",
      "University of Zurich",
    ],
  },
  {
    name: "Tanya Rosenblat",
    role: "Professor of Information and Professor of Economics",
    affiliation: [
      "School of Information and Department of Economics",
      "University of Michigan",
    ],
  },
];

export default function Acknowledgements() {
  return (
    <div className="tool-page active">
      <div className="tool-header">
        <div>
          <h1>Acknowledgements</h1>
          <p className="tool-desc">With thanks to the researchers whose feedback shaped CAT.</p>
        </div>
      </div>

      <div className="tool-body ack-body">
        <section className="ana-section ack-panel">
          <p className="ack-lead">
            CAT is shaped by the researchers who use it. We are grateful to everyone below
            for the time they spent testing the tool and reporting back. Their feedback is
            why features such as coding a subset of rows exist, and why a number of
            reliability problems were found and fixed.
          </p>
          <ul className="ack-list">
            {CONTRIBUTORS.map((person) => (
              <li key={person.name}>
                <span className="ack-name">{person.name}</span>
                {person.role && <span className="ack-aff">{person.role}</span>}
                {person.affiliation?.map((line) => (
                  <span className="ack-aff" key={line}>{line}</span>
                ))}
              </li>
            ))}
          </ul>
        </section>

        <section className="ana-section ack-panel">
          <h2>Send us your feedback</h2>
          <p className="ack-lead">
            Have a suggestion, found a problem, or want to tell us how you are using CAT?
            Write to us here — it reaches the people who maintain the tool, and it is how
            this list grows.
          </p>
          <div className="faq-contact ack-contact"><ContactForm /></div>
        </section>
      </div>
    </div>
  );
}
