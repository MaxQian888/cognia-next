/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/issues/github-comments", () => ({ fetchGithubIssueComments: jest.fn() }))
jest.mock("@/lib/issues/sync-runner", () => ({
  isMissingGithubCredential: (error: unknown) =>
    error instanceof Error && error.name === "MissingGithubCredentialError",
}))

import userEvent from "@testing-library/user-event"
import { render, screen } from "@testing-library/react"
import { GithubCommentsSection } from "./github-comments-section"

const target = { repoFullName: "acme/app", number: 5 }

describe("GithubCommentsSection", () => {
  it("reads nothing until asked", () => {
    const load = jest.fn()
    render(<GithubCommentsSection target={target} load={load} />)
    expect(load).not.toHaveBeenCalled()
    expect(screen.getByTestId("issue-github-comments-load")).toHaveTextContent(
      "githubComments.load"
    )
  })

  it("renders the conversation as plain text, bots and edits marked", async () => {
    const user = userEvent.setup()
    const load = jest.fn(async () => ({
      truncated: true,
      comments: [
        {
          id: 1,
          author: "octocat",
          authorIsBot: false,
          body: "<b>not html</b>",
          createdAt: 1_000,
          updatedAt: 2_000,
          url: "https://github.com/acme/app/issues/5#issuecomment-1",
        },
        {
          id: 2,
          author: "",
          authorIsBot: true,
          body: "CI passed",
          createdAt: 3_000,
          updatedAt: 3_000,
        },
      ],
    }))
    render(<GithubCommentsSection target={target} load={load} />)
    await user.click(screen.getByTestId("issue-github-comments-load"))
    expect(load).toHaveBeenCalledWith(target)
    expect(await screen.findByText("<b>not html</b>")).toBeInTheDocument()
    expect(screen.getByText("octocat")).toBeInTheDocument()
    expect(screen.getByText("githubComments.unknownAuthor")).toBeInTheDocument()
    expect(screen.getByText("githubComments.edited")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "githubComments.open" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/issues/5#issuecomment-1"
    )
    expect(screen.getByText("githubComments.truncated")).toBeInTheDocument()
    expect(screen.getByTestId("issue-github-comments-load")).toHaveTextContent(
      "githubComments.refresh"
    )
  })

  it("says when there are no comments", async () => {
    const user = userEvent.setup()
    render(
      <GithubCommentsSection
        target={target}
        load={async () => ({ comments: [], truncated: false })}
      />
    )
    await user.click(screen.getByTestId("issue-github-comments-load"))
    expect(await screen.findByText("githubComments.empty")).toBeInTheDocument()
  })

  it("points at the credential when none can read the repository", async () => {
    const user = userEvent.setup()
    const missing = Object.assign(new Error("no cred"), { name: "MissingGithubCredentialError" })
    render(
      <GithubCommentsSection
        target={target}
        load={async () => {
          throw missing
        }}
      />
    )
    await user.click(screen.getByTestId("issue-github-comments-load"))
    expect(await screen.findByRole("alert")).toHaveTextContent("sync.noCredential")
  })

  it("reports any other failure", async () => {
    const user = userEvent.setup()
    render(
      <GithubCommentsSection
        target={target}
        load={async () => {
          throw new Error("500")
        }}
      />
    )
    await user.click(screen.getByTestId("issue-github-comments-load"))
    expect(await screen.findByRole("alert")).toHaveTextContent("githubComments.failed")
  })
})
