import { ProjectView } from "@/components/ProjectView";

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  return <ProjectView projectId={id} />;
}
