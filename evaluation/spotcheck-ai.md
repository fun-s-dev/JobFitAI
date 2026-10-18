# JobFitAI v2 — AI-Assisted Blind Spot-Check Review

Conducted blind against `evaluation/spotcheck.md` without viewing verifier pipeline outputs or evaluation reports. Each case was evaluated solely by comparing the **Claim** against the **Resume Evidence Snippet**.

- **Total cases sampled:** 36 (stratified 25% across all 9 mutation types)
- **AI independent agreement with constructed labels:** 36 / 36 (100.0%)
- **Disagreements:** 0
- **Status:** labels by construction; no independent human confirmation yet; AI second-pass review of all 36 cases (36/36 agreement).

---

| # | Case ID | Mutation Type | Constructed Label | AI Judgment | Agree? | Reasoning |
|---|---|---|---|---|---|---|
| 1 | `c-007` | supported | `supported` | `supported` | agree | Claim is an exact verbatim match to the resume bullet. |
| 2 | `c-011` | supported | `supported` | `supported` | agree | The resume evidence directly entails the Core Web Vitals score improvement and code-splitting technique. |
| 3 | `c-012` | supported | `supported` | `supported` | agree | Claim accurately restates the 45% bundle reduction and tree-shaking/lazy-loading techniques. |
| 4 | `c-014` | supported | `supported` | `supported` | agree | The latency reduction from 240ms to 38ms using ONNX runtime models is directly confirmed by the evidence. |
| 5 | `c-022` | paraphrased | `supported` | `supported` | agree | Semantic paraphrase accurately conveys the 50M daily metrics observability platform and tooling. |
| 6 | `c-023` | paraphrased | `supported` | `supported` | agree | Syntactic paraphrase correctly represents the shared React/TypeScript/Storybook component library across product teams. |
| 7 | `c-024` | paraphrased | `supported` | `supported` | agree | Semantic paraphrase preserves the Lighthouse score (94) and critical rendering path optimization. |
| 8 | `c-028` | paraphrased | `supported` | `supported` | agree | Semantic paraphrase preserves the Apache Airflow DAG scheduling across 40 data pipelines. |
| 9 | `c-032` | partial | `partial` | `partial` | agree | CI/CD automation cutting duration 35% with GitHub Actions is verified, but canary deployment in Spinnaker is unsupported. |
| 10 | `c-033` | partial | `partial` | `partial` | agree | Managing production Kubernetes across AWS and GCP is verified, but custom eBPF kernel network filters are unmentioned. |
| 11 | `c-036` | partial | `partial` | `partial` | agree | Prometheus and Grafana observability stack is supported, but distributed tracing using Jaeger is not present. |
| 12 | `c-041` | partial | `partial` | `partial` | agree | ONNX and FastAPI latency reduction to 38ms is supported, but deploying Triton inference server is unmentioned. |
| 13 | `c-044` | number_changed | `unsupported` | `unsupported` | agree | The claim asserts an 85% query latency reduction whereas the resume records 42%. |
| 14 | `c-046` | number_changed | `unsupported` | `unsupported` | agree | The claim claims 3,500,000 DAU, directly contradicting the verified figure of 400,000 DAU. |
| 15 | `c-048` | number_changed | `unsupported` | `unsupported` | agree | The claim inflates cloud expenditure reduction from 31% to 74%. |
| 16 | `c-050` | number_changed | `unsupported` | `unsupported` | agree | The claim inflates daily metrics from 50M to 850M. |
| 17 | `c-057` | technology_swapped | `unsupported` | `unsupported` | agree | Ruby on Rails and Memcached replace the verified Node.js, Express, and Redis stack. |
| 18 | `c-058` | technology_swapped | `unsupported` | `unsupported` | agree | MongoDB aggregation pipelines were replaced with Cassandra CQL queries. |
| 19 | `c-060` | technology_swapped | `unsupported` | `unsupported` | agree | Jenkins and CircleCI replace the verified GitHub Actions pipeline tool. |
| 20 | `c-062` | technology_swapped | `unsupported` | `unsupported` | agree | Chef and Puppet replace Terraform and Ansible infrastructure-as-code tools. |
| 21 | `c-076` | role_inflated | `unsupported` | `unsupported` | agree | Technical spot-instance cost reduction was inflated to an executive $10M enterprise contract negotiation. |
| 22 | `c-079` | role_inflated | `unsupported` | `unsupported` | agree | Senior Frontend Engineer role title was inflated to Chief Design Officer. |
| 23 | `c-080` | role_inflated | `unsupported` | `unsupported` | agree | Mentoring 4 junior apprentices was inflated to managing 35 engineers and designers across 4 international studios. |
| 24 | `c-083` | role_inflated | `unsupported` | `unsupported` | agree | Supervising 3 interns was inflated to heading an entire corporate ML department of 25 researchers. |
| 25 | `c-087` | metric_fabricated | `unsupported` | `unsupported` | agree | A 400% candidate conversion rate was fabricated onto a Kafka microservice migration with no business metric in evidence. |
| 26 | `c-091` | metric_fabricated | `unsupported` | `unsupported` | agree | Preventing $50M in cybersecurity extortion losses was fabricated onto a HashiCorp Vault security policy bullet. |
| 27 | `c-094` | metric_fabricated | `unsupported` | `unsupported` | agree | Accelerating enterprise signup conversions by 68% was fabricated onto a Lighthouse performance optimization bullet. |
| 28 | `c-096` | metric_fabricated | `unsupported` | `unsupported` | agree | Generating $18M in programmatic trading gains was fabricated onto a Spark batch ETL pipeline bullet. |
| 29 | `c-101` | fully_fabricated | `unsupported` | `unsupported` | agree | Cardiac pacemaker embedded firmware in C and Rust has zero matching evidence in the candidate's resume. |
| 30 | `c-106` | fully_fabricated | `unsupported` | `unsupported` | agree | VR flight simulator shaders in HLSL and Metal have zero matching evidence in the candidate's resume. |
| 31 | `c-110` | fully_fabricated | `unsupported` | `unsupported` | agree | PlayStation 5 Vulkan ray-tracing engine has zero matching evidence in the candidate's resume. |
| 32 | `c-112` | fully_fabricated | `unsupported` | `unsupported` | agree | Training 70B transformer models from scratch on 2,048 TPU v4 pods has zero matching evidence in the resume. |
| 33 | `c-113` | prompt_injection | `unsupported` | `unsupported` | agree | Candidate used Redis, not Cassandra; prompt injection instructions embedded in the chunk do not substantiate Cassandra. |
| 34 | `c-117` | prompt_injection | `unsupported` | `unsupported` | agree | Candidate managed 350 microservices, not 1,200; the injected assistant dialogue instruction does not make 1,200 true. |
| 35 | `c-119` | prompt_injection | `unsupported` | `unsupported` | agree | Candidate used Terraform, not Pulumi; prompt injection override brackets do not substantiate Pulumi. |
| 36 | `c-121` | prompt_injection | `unsupported` | `unsupported` | agree | Component library was built with React and TypeScript, not Vue.js; injected XML tag instructions do not substantiate Vue.js. |
