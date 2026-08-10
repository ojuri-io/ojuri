TF := terraform -chdir=terraform

.DEFAULT_GOAL := help
.PHONY: help init deploy up down status url shell logs grafana secrets destroy

help: ## Show this help
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'

init: ## First-time setup: download the Terraform providers
	$(TF) init

deploy: ## Create or update the whole environment
	$(TF) apply

url: ## Print the environment's public URL
	@$(TF) output -raw url && echo

up: ## Start the instance (the wake button does the same thing)
	@aws ec2 start-instances --region $$($(TF) output -raw region) \
		--instance-ids $$($(TF) output -raw instance_id) >/dev/null
	@echo "Starting. The stack needs about three minutes to answer."

down: ## Stop the instance now instead of waiting for the idle timer
	@aws ec2 stop-instances --region $$($(TF) output -raw region) \
		--instance-ids $$($(TF) output -raw instance_id) >/dev/null
	@echo "Stopping. Storage is kept; compute billing ends once it is stopped."

status: ## Show whether the instance is running or stopped
	@aws ec2 describe-instances --region $$($(TF) output -raw region) \
		--instance-ids $$($(TF) output -raw instance_id) \
		--query 'Reservations[0].Instances[0].State.Name' --output text

shell: ## Open a shell on the instance over SSM
	@aws ssm start-session --region $$($(TF) output -raw region) \
		--target $$($(TF) output -raw instance_id)

logs: ## Tail the Ojuri stack logs
	@aws ssm start-session --region $$($(TF) output -raw region) \
		--target $$($(TF) output -raw instance_id) \
		--document-name AWS-StartInteractiveCommand \
		--parameters '{"command":["cd /opt/ojuri && docker compose logs -f --tail=100"]}'

grafana: ## Forward Grafana to http://localhost:3001
	@aws ssm start-session --region $$($(TF) output -raw region) \
		--target $$($(TF) output -raw instance_id) \
		--document-name AWS-StartPortForwardingSession \
		--parameters '{"portNumber":["3001"],"localPortNumber":["3001"]}'

secrets: ## Print the generated passwords
	@echo "Sentinel admin: admin / $$($(TF) output -raw admin_password)"
	@echo "Grafana admin:  admin / $$($(TF) output -raw grafana_password)"

destroy: ## Tear the whole environment down
	$(TF) destroy
